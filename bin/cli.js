#!/usr/bin/env node

import { program } from 'commander';
import { chromium } from 'playwright';
import pc from 'picocolors';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

// Device configurations with logical dimensions (CSS pixels) and device scale factor for precise physical resolution
const DEVICE_CONFIGS = {
  ios: {
    devices: {
      "6.7_inch": { logical: { width: 430, height: 932 }, scale: 3 },  // Fisik: 1290 x 2796 (iPhone 14/15 Pro Max)
      "6.5_inch": { logical: { width: 414, height: 896 }, scale: 3 }   // Fisik: 1242 x 2688 (iPhone Xs Max/11 Pro Max)
    },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
  },
  android: {
    devices: {
      "android_phone": { logical: { width: 360, height: 800 }, scale: 3 },  // Fisik: 1080 x 2400 (Pixel 7 dll)
      "android_tablet": { logical: { width: 800, height: 1280 }, scale: 2 } // Fisik: 1600 x 2560
    },
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36"
  }
};

function promptUser(query, isPassword = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    if (!isPassword) {
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    } else {
      let muted = false;
      const oldWrite = rl._writeToOutput;
      
      rl._writeToOutput = function _writeToOutput(stringToWrite) {
        if (muted) {
          if (stringToWrite === '\r' || stringToWrite === '\n' || stringToWrite === '\r\n') {
            oldWrite.call(rl, stringToWrite);
          }
        } else {
          oldWrite.call(rl, stringToWrite);
        }
      };

      rl.question(query, (answer) => {
        rl.close();
        resolve(answer);
      });
      
      muted = true;
    }
  });
}

function safeFilename(route) {
  const cleanPath = route.replace(/^\/+|\/+$/g, '');
  if (!cleanPath) return 'home';
  return cleanPath.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

// Helper function to scan the src/pages or pages directory (for Astro, Next.js, etc.)
function detectLocalPages(dir = process.cwd()) {
  const pagesDirs = [
    path.join(dir, 'src', 'pages'),
    path.join(dir, 'pages')
  ];
  
  let pagesDir = null;
  for (const p of pagesDirs) {
    if (fs.existsSync(p)) {
      pagesDir = p;
      break;
    }
  }
  
  if (!pagesDir) return null;
  
  const routes = [];
  function scan(currentDir, baseRoute = '') {
    const files = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(currentDir, file.name);
      if (file.isDirectory()) {
        scan(fullPath, `${baseRoute}/${file.name}`);
      } else if (file.isFile()) {
        const ext = path.extname(file.name);
        const name = path.basename(file.name, ext);
        if (['.astro', '.md', '.mdx', '.html', '.js', '.jsx', '.ts', '.tsx'].includes(ext.toLowerCase())) {
          let route = `${baseRoute}/${name}`;
          if (name === 'index') {
            route = baseRoute || '/';
          }
          // Ignore dynamic routes containing [ or ]
          if (!route.includes('[') && !route.includes(']')) {
            // Ensure it starts with /
            let finalRoute = '/' + route.replace(/^\/+/, '');
            // Ignore API routes (server endpoints)
            if (!finalRoute.startsWith('/api/')) {
              routes.push(finalRoute);
            }
          }
        }
      }
    }
  }
  
  scan(pagesDir);
  return [...new Set(routes)];
}

// Helper function to crawl internal links starting from the home page
async function analyzeRoutes(browser, baseUrl, initialPaths, email, password, loginPath, addHtml, crawl) {
  const normLoginPath = '/' + loginPath.replace(/^\/+/, '');
  const publicRoutes = new Set();
  const authRoutes = new Set();
  const allDetectedRoutes = new Set(initialPaths);

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('Failed to fetch') || text.includes('TypeError: Failed to fetch')) {
      return;
    }
    if (text.includes('[ERROR]') || text.includes('[WARN]')) {
      console.log(pc.dim(`      [Crawler Log] ${text}`));
    }
  });
  page.on('pageerror', err => {
    if (err.message.includes('Failed to fetch') || err.message.includes('TypeError: Failed to fetch')) return;
    console.error(pc.red(`      [Crawler Error] ${err.message}`));
  });

  const nonAuthSpinner = ora('Analyzing public routes and detecting authentication requirements...').start();
  const routesToCheck = Array.from(allDetectedRoutes);

  // If the initial path list is empty, default to the root path '/'
  if (routesToCheck.length === 0) {
    routesToCheck.push('/');
    allDetectedRoutes.add('/');
  }

  for (let i = 0; i < routesToCheck.length; i++) {
    const route = routesToCheck[i];
    let cleanRoute = route;
    if (addHtml && cleanRoute !== '/' && !cleanRoute.endsWith('.html')) {
      cleanRoute += '.html';
    }

    const targetUrl = `${baseUrl}${cleanRoute}`;
    try {
      await page.goto(targetUrl, { timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      
      // Wait dynamically for client-side redirects (such as splash screen to login) to complete
      if (cleanRoute === '/' || cleanRoute.includes('splash')) {
        await page.waitForURL(u => {
          const pathname = u.pathname;
          return pathname !== '/' && !pathname.includes('splash');
        }, { timeout: 15000 }).catch(() => {});
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      const finalUrl = page.url();
      let finalPath = '';
      try {
        finalPath = new URL(finalUrl).pathname;
      } catch (err) {
        finalPath = finalUrl;
      }

      // Normalize finalPath to end with .html if the flag is active
      if (addHtml && finalPath !== '/' && !finalPath.endsWith('.html') && !/\.[a-z0-9]+$/i.test(finalPath)) {
        finalPath += '.html';
      }

      // Check if a login form or credential inputs are present in the current page DOM
      const hasLoginForm = await page.evaluate(() => {
        const hasUser = !!document.querySelector('#username, input[type="email"], input[name="username"], input[name="login"]');
        const hasPass = !!document.querySelector('#password, input[type="password"], input[name="password"]');
        const hasForm = !!document.querySelector('#loginForm, form.login-form, form[action*="login"]');
        return (hasUser && hasPass) || hasForm;
      });

      const isRedirectToLogin = hasLoginForm ||
                               finalPath.includes('login') || 
                               finalPath.includes('splash') || 
                               finalPath === normLoginPath || 
                               finalUrl.includes('login') || 
                               finalUrl.includes('splash');

      if (isRedirectToLogin) {
        if (cleanRoute !== '/' && cleanRoute !== normLoginPath && !cleanRoute.includes('splash') && !cleanRoute.includes('login')) {
          authRoutes.add(cleanRoute);
        } else {
          publicRoutes.add(cleanRoute);
        }

        // Tambahkan rute login itu sendiri (tujuan redirect) ke rute publik untuk dianalisis/di-crawl
        if (!allDetectedRoutes.has(finalPath)) {
          routesToCheck.push(finalPath);
          allDetectedRoutes.add(finalPath);
        }
      } else {
        publicRoutes.add(cleanRoute);
      }

      // Always crawl public links if crawling is active and the current page does not require authentication
      if (crawl && !authRoutes.has(cleanRoute)) {
        const hrefs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a'))
            .map(a => a.getAttribute('href'))
            .filter(Boolean);
        });

        const baseOrigin = new URL(baseUrl).origin;
        for (const href of hrefs) {
          try {
            const resolvedUrl = new URL(href, baseUrl);
            if (resolvedUrl.origin === baseOrigin) {
              let r = resolvedUrl.pathname;
              if (!/\.(pdf|png|jpg|jpeg|gif|css|js|svg|ico|woff|woff2|json)$/i.test(r)) {
                let normalizedR = '/' + r.replace(/^\/+|\/+$/g, '');
                if (normalizedR === '//') normalizedR = '/';
                
                if (addHtml && normalizedR !== '/' && !normalizedR.endsWith('.html')) {
                  normalizedR += '.html';
                }

                if (/logout|signout/i.test(normalizedR)) {
                  continue;
                }

                if (!allDetectedRoutes.has(normalizedR)) {
                  routesToCheck.push(normalizedR);
                  allDetectedRoutes.add(normalizedR);
                }
              }
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      ora().warn(pc.yellow(`Failed to analyze route ${cleanRoute}: ${err.message}`));
      publicRoutes.add(cleanRoute);
    }
  }
  
  await context.close();
  nonAuthSpinner.succeed(`Initial analysis complete. Detected ${publicRoutes.size} public routes and ${authRoutes.size} routes requiring authentication.`);

  // 2. Prompt for credentials interactively if there are authenticated routes and email/password are empty
  let finalEmail = email;
  let finalPassword = password;

  if (authRoutes.size > 0 && (!finalEmail || !finalPassword)) {
    console.log(pc.yellow(`\n🔑 Detected ${authRoutes.size} pages requiring login.`));
    if (!finalEmail) {
      finalEmail = await promptUser('👉 Enter Email/Username: ');
    }
    if (!finalPassword) {
      finalPassword = await promptUser('👉 Enter Password (hidden input): ', true);
      console.log(''); // new line after pressing enter
    }
  }

  // 3. Phase Two Crawl (Post-Login) to discover internal dashboard pages
  if (authRoutes.size > 0 && finalEmail && finalPassword) {
    const authCrawlSpinner = ora('Performing login and crawling authenticated internal pages...').start();
    const authContext = await browser.newContext();
    const authPage = await authContext.newPage();

    authPage.on('console', msg => {
      const text = msg.text();
      if (text.includes('Failed to fetch') || text.includes('TypeError: Failed to fetch')) {
        return;
      }
      if (text.includes('[ERROR]') || text.includes('[WARN]')) {
        console.log(pc.dim(`      [Auth-Crawler Log] ${text}`));
      }
    });
    authPage.on('pageerror', err => {
      if (err.message.includes('Failed to fetch') || err.message.includes('TypeError: Failed to fetch')) return;
      console.error(pc.red(`      [Auth-Crawler Error] ${err.message}`));
    });

    try {
      const targetLoginUrl = `${baseUrl}${normLoginPath}`;
      await authPage.goto(targetLoginUrl, { timeout: 20000 });
      await authPage.waitForSelector('#username', { timeout: 10000 });
      await authPage.waitForSelector('#password', { timeout: 10000 });
      await authPage.fill('#username', finalEmail);
      await authPage.fill('#password', finalPassword);
      
      const submitBtn = await authPage.locator('button[type="submit"], button.save-btn').first();
      await submitBtn.click();
      
      // Tunggu hingga login berhasil (URL berubah) atau ada error message
      let loginSuccess = false;
      let loginError = '';
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const currentUrl = authPage.url();
        if (!currentUrl.includes('login') && !currentUrl.includes('splash')) {
          loginSuccess = true;
          break;
        }
        let errorText = null;
        try {
          errorText = await authPage.evaluate(() => {
            const el = document.getElementById('errorMessage');
            return el && !el.classList.contains('hidden') ? el.textContent : null;
          });
        } catch (e) {
          // Ignore context destruction error during redirect/navigation
        }
        if (errorText) {
          loginError = errorText.trim();
          break;
        }
      }

      if (!loginSuccess) {
        throw new Error(loginError || 'Timeout: Page URL did not change from the login page after 10 seconds.');
      }

      if (crawl) {
        const authRoutesArray = Array.from(authRoutes);
        for (const route of authRoutesArray) {
          const targetUrl = `${baseUrl}${route}`;
          try {
            await authPage.goto(targetUrl, { timeout: 15000 });
            await authPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

            const hrefs = await authPage.evaluate(() => {
              return Array.from(document.querySelectorAll('a'))
                .map(a => a.getAttribute('href'))
                .filter(Boolean);
            });

            const baseOrigin = new URL(baseUrl).origin;
            for (const href of hrefs) {
              try {
                const resolvedUrl = new URL(href, baseUrl);
                if (resolvedUrl.origin === baseOrigin) {
                  let r = resolvedUrl.pathname;
                  
                  // Filter out logout/signout
                  if (/logout|signout/i.test(r)) {
                    continue;
                  }

                  if (!/\.(pdf|png|jpg|jpeg|gif|css|js|svg|ico|woff|woff2|json)$/i.test(r)) {
                    let normalizedR = '/' + r.replace(/^\/+|\/+$/g, '');
                    if (normalizedR === '//') normalizedR = '/';

                    if (addHtml && normalizedR !== '/' && !normalizedR.endsWith('.html')) {
                      normalizedR += '.html';
                    }

                    if (!publicRoutes.has(normalizedR) && !authRoutes.has(normalizedR)) {
                      authRoutes.add(normalizedR);
                    }
                  }
                }
              } catch (e) {}
            }
          } catch (routeErr) {
            // Ignore if a specific route fails to load
          }
        }
      }
      authCrawlSpinner.succeed(`Post-login crawl complete. Found a total of ${authRoutes.size} authenticated routes.`);
    } catch (err) {
      authCrawlSpinner.fail(`Failed to crawl authenticated pages: ${err.message}`);
    } finally {
      await authContext.close();
    }
  }

  return {
    publicRoutes: Array.from(publicRoutes),
    authRoutes: Array.from(authRoutes),
    email: finalEmail,
    password: finalPassword
  };
}

async function applyMockupBorder(browser, imageBuffer, deviceName, size, platform, isDarkTheme = false) {
  const base64Image = imageBuffer.toString('base64');
  
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const timeString = `${hours}:${minutes}`;
  
  const textColor = isDarkTheme ? '#ffffff' : '#000000';
  const svgFill = isDarkTheme ? '#ffffff' : '#000000';
  const batteryBorder = isDarkTheme ? '#ffffff' : '#000000';
  const batteryLevelBg = isDarkTheme ? '#ffffff' : '#000000';
  const indicatorBg = isDarkTheme ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.8)';
  const androidIndicatorBg = isDarkTheme ? 'rgba(255, 255, 255, 0.6)' : 'rgba(0, 0, 0, 0.5)';
  const tabletIndicatorBg = isDarkTheme ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.3)';

  let frameClass = 'ios';
  let topElementHTML = '<div class="dynamic-island"></div>';
  let statusBarHTML = `
    <div class="status-bar" style="height: 44px; padding: 0 32px; color: ${textColor};">
      <div class="time">${timeString}</div>
      <div class="status-right">
        <svg width="17" height="11" viewBox="0 0 17 11" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="0.5" y="8" width="2.5" height="3" rx="0.5" fill="${svgFill}"/>
          <rect x="4.5" y="6" width="2.5" height="5" rx="0.5" fill="${svgFill}"/>
          <rect x="8.5" y="4" width="2.5" height="7" rx="0.5" fill="${svgFill}"/>
          <rect x="12.5" y="1" width="2.5" height="10" rx="0.5" fill="${svgFill}"/>
        </svg>
        <svg width="15" height="11" viewBox="0 0 15 11" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-left: 2px;">
          <path d="M7.5 11C8.32843 11 9 10.3284 9 9.5C9 8.67157 8.32843 8 7.5 8C6.67157 8 6 8.67157 6 9.5C6 10.3284 6.67157 11 7.5 11Z" fill="${svgFill}"/>
          <path fill-rule="evenodd" clip-rule="evenodd" d="M7.5 0C4.33806 0 1.50341 1.25414 0.556274 3.25056C0.370701 3.6417 0.53606 4.10842 0.926066 4.29815L1.87955 4.762C2.2612 4.94766 2.72124 4.7954 2.91572 4.41724C3.6067 3.07342 5.37895 2 7.5 2C9.62105 2 11.3933 3.07342 12.0843 4.41724C12.2788 4.7954 12.7388 4.94766 13.1205 4.762L14.0739 4.29815C14.4639 4.10842 14.6293 3.6417 14.4437 3.25056C13.4966 1.25414 10.6619 0 7.5 0ZM7.5 4C5.77259 4 4.22699 4.67499 3.6705 5.76077C3.47953 6.13333 3.62649 6.58988 3.99878 6.78168L4.95227 7.27282C5.33027 7.46752 5.79287 7.32483 5.99221 6.95353C6.26241 6.45028 6.83756 6 7.5 6C8.16244 6 8.73759 6.45028 9.00779 6.95353C9.20713 7.32483 9.66973 7.46752 10.0477 7.27282L11.0012 6.78168C11.3735 6.58988 11.5205 6.13333 11.3295 5.76077C10.773 4.67499 9.22741 4 7.5 4Z" fill="${svgFill}"/>
        </svg>
        <div class="battery" style="margin-left: 2px; border-color: ${batteryBorder};"><div class="battery-level" style="background-color: ${batteryLevelBg};"></div></div>
      </div>
    </div>
  `;
  let bottomElementHTML = `<div class="home-indicator" style="background: ${indicatorBg};"></div>`;
  
  if (platform === 'android') {
    if (deviceName.includes('tablet')) {
      frameClass = 'android-tablet';
      topElementHTML = '';
      statusBarHTML = `
        <div class="status-bar" style="height: 32px; padding: 0 20px; font-size: 10px; line-height: 32px; color: ${textColor};">
          <div class="time">${timeString}</div>
          <div class="status-right">
            <span>🛜</span>
            <span style="margin-left: 4px; color: ${textColor};">🔋 100%</span>
          </div>
        </div>
      `;
      bottomElementHTML = `<div class="home-indicator" style="width: 160px; height: 4px; bottom: 4px; background: ${tabletIndicatorBg};"></div>`;
    } else {
      frameClass = 'android-phone';
      topElementHTML = '<div class="punch-hole"></div>';
      statusBarHTML = `
        <div class="status-bar" style="height: 38px; padding: 0 24px; font-size: 11px; line-height: 38px; color: ${textColor};">
          <div class="time">${timeString}</div>
          <div class="status-right">
            <svg width="15" height="11" viewBox="0 0 17 11" fill="none" xmlns="http://www.w3.org/2000/svg" style="transform: scale(0.9); margin-left: 2px;">
              <rect x="0.5" y="8" width="2.5" height="3" rx="0.5" fill="${svgFill}"/>
              <rect x="4.5" y="6" width="2.5" height="5" rx="0.5" fill="${svgFill}"/>
              <rect x="8.5" y="4" width="2.5" height="7" rx="0.5" fill="${svgFill}"/>
              <rect x="12.5" y="1" width="2.5" height="10" rx="0.5" fill="${svgFill}"/>
            </svg>
            <svg width="13" height="11" viewBox="0 0 15 11" fill="none" xmlns="http://www.w3.org/2000/svg" style="transform: scale(0.9); margin-left: 2px;">
              <path d="M7.5 11C8.32843 11 9 10.3284 9 9.5C9 8.67157 8.32843 8 7.5 8C6.67157 8 6 8.67157 6 9.5C6 10.3284 6.67157 11 7.5 11Z" fill="${svgFill}"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M7.5 0C4.33806 0 1.50341 1.25414 0.556274 3.25056C0.370701 3.6417 0.53606 4.10842 0.926066 4.29815L1.87955 4.762C2.2612 4.94766 2.72124 4.7954 2.91572 4.41724C3.6067 3.07342 5.37895 2 7.5 2C9.62105 2 11.3933 3.07342 12.0843 4.41724C12.2788 4.7954 12.7388 4.94766 13.1205 4.762L14.0739 4.29815C14.4639 4.10842 14.6293 3.6417 14.4437 3.25056C13.4966 1.25414 10.6619 0 7.5 0ZM7.5 4C5.77259 4 4.22699 4.67499 3.6705 5.76077C3.47953 6.13333 3.62649 6.58988 3.99878 6.78168L4.95227 7.27282C5.33027 7.46752 5.79287 7.32483 5.99221 6.95353C6.26241 6.45028 6.83756 6 7.5 6C8.16244 6 8.73759 6.45028 9.00779 6.95353C9.20713 7.32483 9.66973 7.46752 10.0477 7.27282L11.0012 6.78168C11.3735 6.58988 11.5205 6.13333 11.3295 5.76077C10.773 4.67499 9.22741 4 7.5 4Z" fill="${svgFill}"/>
            </svg>
            <div class="battery" style="border-radius: 2px; margin-left: 2px; border-color: ${batteryBorder};"><div class="battery-level" style="background-color: ${batteryLevelBg};"></div></div>
          </div>
        </div>
      `;
      bottomElementHTML = `<div class="home-indicator" style="background: ${androidIndicatorBg}; width: 120px; bottom: 6px;"></div>`;
    }
  }

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    overflow: hidden;
  }
  body {
    background: transparent;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .device-wrapper {
    position: relative;
    padding: 40px; /* space for shadow */
    display: inline-block;
    background: transparent;
  }
  .device-frame {
    position: relative;
    background: #000;
    box-shadow: 
      0 0 0 12px #1f1f21,
      0 0 0 13px #2f2f31,
      0 20px 50px rgba(0,0,0,0.6);
    overflow: hidden;
  }
  .device-frame.ios {
    border-radius: 54px;
  }
  .device-frame.ios .screenshot-img {
    border-radius: 42px;
  }
  .device-frame.android-phone {
    border-radius: 40px;
    box-shadow: 
      0 0 0 10px #2a2a2c,
      0 0 0 11px #3a3a3c,
      0 20px 50px rgba(0,0,0,0.6);
  }
  .device-frame.android-phone .screenshot-img {
    border-radius: 30px;
  }
  .device-frame.android-tablet {
    border-radius: 24px;
    box-shadow: 
      0 0 0 14px #2a2a2c,
      0 20px 50px rgba(0,0,0,0.6);
  }
  .device-frame.android-tablet .screenshot-img {
    border-radius: 12px;
  }
  .screenshot-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .dynamic-island {
    position: absolute;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    width: 110px;
    height: 28px;
    background: #000;
    border-radius: 20px;
    z-index: 100;
    border: 0.5px solid rgba(255, 255, 255, 0.08);
  }
  .dynamic-island::after {
    content: '';
    position: absolute;
    right: 25px;
    top: 10px;
    width: 8px;
    height: 8px;
    background: #111124;
    border-radius: 50%;
    box-shadow: inset 0 0 2px rgba(255,255,255,0.2);
  }
  .punch-hole {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    width: 12px;
    height: 12px;
    background: #000;
    border-radius: 50%;
    z-index: 100;
    border: 1px solid rgba(255,255,255,0.15);
  }
  .status-bar {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: #fff;
    font-weight: 600;
    z-index: 99;
    letter-spacing: -0.2px;
  }
  .status-right {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .battery {
    width: 20px;
    height: 10.5px;
    border: 1px solid #fff;
    border-radius: 3px;
    position: relative;
    padding: 1px;
  }
  .battery::after {
    content: '';
    position: absolute;
    right: -3px;
    top: 2px;
    width: 2px;
    height: 4.5px;
    background: #fff;
    border-radius: 0 1px 1px 0;
  }
  .battery-level {
    width: 100%;
    height: 100%;
    background: #fff;
    border-radius: 1px;
  }
  .home-indicator {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    width: 140px;
    height: 5px;
    background: rgba(255, 255, 255, 0.85);
    border-radius: 10px;
    z-index: 100;
  }
</style>
</head>
<body>
  <div class="device-wrapper">
    <div class="device-frame ${frameClass}" style="width: ${size.logical.width}px; height: ${size.logical.height}px;">
      ${topElementHTML}
      ${statusBarHTML}
      <img src="data:image/png;base64,${base64Image}" class="screenshot-img" />
      ${bottomElementHTML}
    </div>
  </div>
</body>
</html>
  `;

  const extraWidth = 150;
  const extraHeight = 150;
  const context = await browser.newContext({
    viewport: { 
      width: size.logical.width + extraWidth, 
      height: size.logical.height + extraHeight 
    },
    deviceScaleFactor: size.scale
  });
  
  const page = await context.newPage();
  await page.setContent(htmlContent);
  await page.waitForLoadState('networkidle');
  
  const buffer = await page.locator('.device-wrapper').screenshot({
    omitBackground: true
  });
  
  await context.close();
  return buffer;
}

async function captureScreenshots(url, paths, outputDir, platform, crawl, detectPages, email, password, loginPath, addHtml, mockup) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }
  url = url.replace(/\/+$/, '');

  let targetPlatforms = [];
  if (platform === 'both') {
    targetPlatforms = ['ios', 'android'];
  } else {
    targetPlatforms = [platform];
  }

  let finalPaths = [...paths];

  // 1. Auto-detect local pages if enabled
  if (detectPages) {
    const localRoutes = detectLocalPages();
    if (localRoutes && localRoutes.length > 0) {
      console.log(pc.green(`🔍 Detected local pages folder. Adding ${localRoutes.length} static routes.`));
      finalPaths = [...new Set([...finalPaths, ...localRoutes])];
    } else {
      console.log(pc.yellow(`⚠ Folder 'src/pages' or 'pages' not found in the current directory.`));
    }
  }

  console.log(pc.bold(pc.blue('Starting MobileSnap screenshot automation...')));
  console.log(`Target Server: ${pc.cyan(url)}`);
  console.log(`Platform(s): ${pc.cyan(targetPlatforms.join(', ').toUpperCase())}`);
  console.log(`Output Directory: ${pc.cyan(path.resolve(outputDir))}\n`);

  // Ensure the output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Launch browser
  let browser;
  const launchSpinner = ora('Launching Chromium browser...').start();
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-web-security']
    });
    launchSpinner.succeed('Chromium browser launched successfully');
  } catch (err) {
    launchSpinner.fail(pc.red('Failed to launch Chromium browser'));
    console.error(pc.red(err.message));
    console.log(pc.yellow('\n💡 Tip: Run "npx playwright install chromium" to download browser binaries.'));
    process.exit(1);
  }

  // Call analyzeRoutes to separate public and authenticated routes
  let result;
  try {
    result = await analyzeRoutes(browser, url, finalPaths, email, password, loginPath, addHtml, crawl);
  } catch (err) {
    console.error(pc.red(`Failed to analyze routes: ${err.message}`));
    await browser.close();
    process.exit(1);
  }

  const { publicRoutes, authRoutes, email: finalEmail, password: finalPassword } = result;

  console.log(pc.bold(`\nDetected Public Routes (${publicRoutes.length}):`));
  publicRoutes.forEach(p => console.log(`  - ${pc.green(p)}`));
  
  if (authRoutes.length > 0) {
    console.log(pc.bold(`\nDetected Routes Requiring Authentication (${authRoutes.length}):`));
    authRoutes.forEach(p => console.log(`  - ${pc.cyan(p)}`));
  }
  console.log('');

  if (publicRoutes.length === 0 && authRoutes.length === 0) {
    console.log(pc.yellow('No routes were found to capture.'));
    await browser.close();
    return;
  }

  for (const plat of targetPlatforms) {
    const config = DEVICE_CONFIGS[plat];
    console.log(pc.bold(pc.blue(`💻 Platform: ${plat.toUpperCase()}`)));

    for (const [deviceName, size] of Object.entries(config.devices)) {
      console.log(pc.magenta(`  📱 Processing ${deviceName} (${size.logical.width * size.scale}x${size.logical.height * size.scale}px)...`));

      const deviceOutputDir = path.join(outputDir, plat, deviceName);
      if (!fs.existsSync(deviceOutputDir)) {
        fs.mkdirSync(deviceOutputDir, { recursive: true });
      }

      const context = await browser.newContext({
        viewport: size.logical,
        userAgent: config.userAgent,
        deviceScaleFactor: size.scale,
        isMobile: true,
        hasTouch: true
      });

      const page = await context.newPage();

      const saveScreenshot = async (outputPath) => {
        if (mockup) {
          const isDarkTheme = await page.evaluate(() => {
            const bodyBg = window.getComputedStyle(document.body).backgroundColor;
            const match = bodyBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (match) {
              const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3]);
              const brightness = (r * 299 + g * 587 + b * 114) / 1000;
              const alphaMatch = bodyBg.match(/rgba?\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)/);
              if (alphaMatch && parseFloat(alphaMatch[1]) < 0.1) {
                // semi-transparent, fall back to text color check
              } else {
                return brightness < 128;
              }
            }
            const bodyColor = window.getComputedStyle(document.body).color;
            const colorMatch = bodyColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (colorMatch) {
              const r = parseInt(colorMatch[1]), g = parseInt(colorMatch[2]), b = parseInt(colorMatch[3]);
              const brightness = (r * 299 + g * 587 + b * 114) / 1000;
              return brightness > 128;
            }
            return false;
          });

          const raw = await page.screenshot({ fullPage: false });
          const framed = await applyMockupBorder(browser, raw, deviceName, size, plat, isDarkTheme);
          fs.writeFileSync(outputPath, framed);
        } else {
          await page.screenshot({ path: outputPath, fullPage: false });
        }
      };

      // Forward browser console logs and errors to terminal for debugging
      page.on('console', msg => {
        const text = msg.text();
        if (text.includes('Failed to fetch') || text.includes('TypeError: Failed to fetch')) {
          return;
        }
        // filter out noisy logs but keep useful ones
        if (text.includes('[ERROR]') || text.includes('[WARN]')) {
          console.log(pc.dim(`      [Browser Log] ${text}`));
        }
      });
      page.on('pageerror', err => {
        if (err.message.includes('Failed to fetch') || err.message.includes('TypeError: Failed to fetch')) return;
        console.error(pc.red(`      [Browser Error] ${err.message}`));
      });

      // --- Phase 1: Capturing Public Pages (No Login) ---
      if (publicRoutes.length > 0) {
        console.log(`    📸 Capturing public pages...`);
        for (const route of publicRoutes) {
          const targetUrl = `${url}${route}`;
          const nameSnippet = safeFilename(route);
          const filename = `${nameSnippet}.png`;
          const outputPath = path.join(deviceOutputDir, filename);

          const pageSpinner = ora(`      Navigating to ${route}...`).start();
          try {
            await page.goto(targetUrl, { timeout: 30000 });
            pageSpinner.text = `      Waiting for network idle on ${route}...`;
            await page.waitForLoadState('networkidle', { timeout: 15000 });
            await new Promise(resolve => setTimeout(resolve, 800));

            pageSpinner.text = `      Saving screenshot ${filename}...`;
            await saveScreenshot(outputPath);
            pageSpinner.succeed(pc.green(`     ✔ Saved ${plat}/${deviceName}/${filename}`));
          } catch (err) {
            pageSpinner.fail(pc.red(`     ✘ Failed to capture ${route}: ${err.message}`));
          }
        }
      }

      // --- Phase 2: Capturing Authenticated Pages ---
      if (authRoutes.length > 0) {
        if (finalEmail && finalPassword) {
          const loginSpinner = ora(`    Logging in to session for ${deviceName}...`).start();
          try {
            const targetLoginUrl = `${url}/${loginPath.replace(/^\/+/, '')}`;
            await page.goto(targetLoginUrl, { timeout: 30000 });
            await page.waitForSelector('#username', { timeout: 10000 });
            await page.waitForSelector('#password', { timeout: 10000 });
            await page.fill('#username', finalEmail);
            await page.fill('#password', finalPassword);

            const submitBtn = await page.locator('button[type="submit"], button.save-btn').first();
            await submitBtn.click();
            
            // Wait for login success (URL change) or an error message to appear
            let loginSuccess = false;
            let loginError = '';
            for (let i = 0; i < 40; i++) {
              await new Promise(resolve => setTimeout(resolve, 250));
              const currentUrl = page.url();
              if (!currentUrl.includes('login') && !currentUrl.includes('splash')) {
                loginSuccess = true;
                break;
              }
              let errorText = null;
              try {
                errorText = await page.evaluate(() => {
                  const el = document.getElementById('errorMessage');
                  return el && !el.classList.contains('hidden') ? el.textContent : null;
                });
              } catch (e) {
                // Ignore context destruction error during redirect/navigation
              }
              if (errorText) {
                loginError = errorText.trim();
                break;
              }
            }

            if (!loginSuccess) {
              throw new Error(loginError || 'Timeout: Page URL did not change from the login page after 10 seconds.');
            }

            loginSpinner.succeed(`    Logged in successfully for ${deviceName}`);

            console.log(`    📸 Capturing authenticated pages...`);
            for (const route of authRoutes) {
              const targetUrl = `${url}${route}`;
              const nameSnippet = safeFilename(route);
              const filename = `${nameSnippet}.png`;
              const outputPath = path.join(deviceOutputDir, filename);

              const pageSpinner = ora(`      Navigating to ${route}...`).start();
              try {
                await page.goto(targetUrl, { timeout: 30000 });
                pageSpinner.text = `      Waiting for network idle on ${route}...`;
                await page.waitForLoadState('networkidle', { timeout: 15000 });
                await new Promise(resolve => setTimeout(resolve, 800));

                pageSpinner.text = `      Saving screenshot ${filename}...`;
                await saveScreenshot(outputPath);
                pageSpinner.succeed(pc.green(`     ✔ Saved ${plat}/${deviceName}/${filename}`));
              } catch (err) {
                pageSpinner.fail(pc.red(`     ✘ Failed to capture ${route}: ${err.message}`));
              }
            }
          } catch (loginErr) {
            loginSpinner.fail(pc.red(`    Auto-login failed for ${deviceName}: ${loginErr.message}`));
            console.log(pc.yellow(`    💡 Continuing to capture authenticated routes without login (may be redirected to login/splash).`));
            
            for (const route of authRoutes) {
              const targetUrl = `${url}${route}`;
              const nameSnippet = safeFilename(route);
              const filename = `${nameSnippet}.png`;
              const outputPath = path.join(deviceOutputDir, filename);

              const pageSpinner = ora(`      Navigating to ${route}...`).start();
              try {
                await page.goto(targetUrl, { timeout: 30000 });
                pageSpinner.text = `      Waiting for network idle on ${route}...`;
                await page.waitForLoadState('networkidle', { timeout: 15000 });
                await new Promise(resolve => setTimeout(resolve, 800));

                pageSpinner.text = `      Saving screenshot ${filename}...`;
                await saveScreenshot(outputPath);
                pageSpinner.succeed(pc.green(`     ✔ Saved ${plat}/${deviceName}/${filename}`));
              } catch (err) {
                pageSpinner.fail(pc.red(`     ✘ Failed to capture ${route}: ${err.message}`));
              }
            }
          }
        } else {
          console.log(pc.yellow(`    ⚠ Skipping login (empty credentials). Capturing authenticated routes without login.`));
          for (const route of authRoutes) {
            const targetUrl = `${url}${route}`;
            const nameSnippet = safeFilename(route);
            const filename = `${nameSnippet}.png`;
            const outputPath = path.join(deviceOutputDir, filename);

            const pageSpinner = ora(`      Navigating to ${route}...`).start();
            try {
              await page.goto(targetUrl, { timeout: 30000 });
              pageSpinner.text = `      Waiting for network idle on ${route}...`;
              await page.waitForLoadState('networkidle', { timeout: 15000 });
              await new Promise(resolve => setTimeout(resolve, 800));

              pageSpinner.text = `      Saving screenshot ${filename}...`;
              await saveScreenshot(outputPath);
              pageSpinner.succeed(pc.green(`     ✔ Saved ${plat}/${deviceName}/${filename}`));
            } catch (err) {
              pageSpinner.fail(pc.red(`     ✘ Failed to capture ${route}: ${err.message}`));
            }
          }
        }
      }

      await context.close();
    }
  }

  await browser.close();
  console.log(pc.bold(pc.green(`\n🎉 Finished! All screenshots successfully saved in '${outputDir}'.`)));
}

program
  .name('mobile-snap')
  .description('⚡ MobileSnap CLI: Automate App Store & Google Play Store screenshots')
  .version('1.0.5')
  .requiredOption('-u, --url <url>', 'Base URL of the local development server (e.g. localhost:3000)')
  .option('-p, --paths <paths>', 'Comma-separated list of routes to capture', '/')
  .option('-o, --output <output>', 'Output directory to save screenshots', 'mobilesnap_output')
  .option('-l, --platform <platform>', 'Target platform: "ios", "android", or "both"', 'ios')
  .option('-c, --crawl', 'Discover and screenshot all internal links automatically', false)
  .option('-d, --detect-pages', 'Scan local project pages directory (src/pages or pages) for static routes', false)
  .option('--email <email>', 'Email for automatic login authentication')
  .option('--password <password>', 'Password for automatic login authentication')
  .option('--login-path <path>', 'Path to the login page', '/login.html')
  .option('--html', 'Auto append .html extension to detected routes', false)
  .option('-m, --mockup', 'Wrap screenshots in a beautiful iPhone/Android device mockup frame', false)
  .action((options) => {
    let pathList = [];
    if (options.paths) {
      pathList = options.paths.split(',').map(p => p.trim()).filter(Boolean);
    }
    
    const platformVal = options.platform.toLowerCase();
    if (!['ios', 'android', 'both'].includes(platformVal)) {
      console.error(pc.red(`Error: Invalid platform '${options.platform}'. Choose 'ios', 'android', or 'both'.`));
      process.exit(1);
    }

    captureScreenshots(
      options.url,
      pathList,
      options.output,
      platformVal,
      options.crawl,
      options.detectPages,
      options.email,
      options.password,
      options.loginPath,
      options.html,
      options.mockup
    ).catch(err => {
      console.error(pc.red(`An unexpected error occurred: ${err.message}`));
      process.exit(1);
    });
  });

program.parse(process.argv);

