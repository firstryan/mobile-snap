#!/usr/bin/env node

import { program } from 'commander';
import { chromium } from 'playwright';
import pc from 'picocolors';
import ora from 'ora';
import fs from 'fs';
import path from 'path';

// Device configurations grouped by platform
const DEVICE_CONFIGS = {
  ios: {
    devices: {
      "6.7_inch": { width: 1290, height: 2796 },
      "6.5_inch": { width: 1242, height: 2688 }
    },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
  },
  android: {
    devices: {
      "android_phone": { width: 1080, height: 2400 },
      "android_tablet": { width: 1600, height: 2560 }
    },
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36"
  }
};

function safeFilename(route) {
  const cleanPath = route.replace(/^\/+|\/+$/g, '');
  if (!cleanPath) return 'home';
  return cleanPath.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

async function captureScreenshots(url, paths, outputDir, platform) {
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

  console.log(pc.bold(pc.blue('Starting MobileSnap screenshot automation...')));
  console.log(`Target Server: ${pc.cyan(url)}`);
  console.log(`Platform(s): ${pc.cyan(targetPlatforms.join(', ').toUpperCase())}`);
  console.log(`Output Directory: ${pc.cyan(path.resolve(outputDir))}\n`);

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let browser;
  const launchSpinner = ora('Launching Chromium browser...').start();
  try {
    browser = await chromium.launch({ headless: true });
    launchSpinner.succeed('Chromium browser launched successfully');
  } catch (err) {
    launchSpinner.fail(pc.red('Failed to launch Chromium browser'));
    console.error(pc.red(err.message));
    console.log(pc.yellow('\n💡 Tips: Jalankan "npx playwright install chromium" untuk mengunduh browser binaries.'));
    process.exit(1);
  }

  for (const plat of targetPlatforms) {
    const config = DEVICE_CONFIGS[plat];
    console.log(pc.bold(pc.blue(`💻 Platform: ${plat.toUpperCase()}`)));

    for (const [deviceName, size] of Object.entries(config.devices)) {
      console.log(pc.magenta(`  📱 Processing ${deviceName} (${size.width}x${size.height}px)...`));

      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        userAgent: config.userAgent,
        deviceScaleFactor: 3, // High DPI for crisp screenshots
        isMobile: true,
        hasTouch: true
      });

      const page = await context.newPage();

      for (const route of paths) {
        const normalizedPath = '/' + route.replace(/^\/+/, '');
        const targetUrl = `${url}${normalizedPath}`;
        const nameSnippet = safeFilename(normalizedPath);
        const filename = `${deviceName}_${nameSnippet}.png`;
        const outputPath = path.join(outputDir, filename);

        const pageSpinner = ora(`    Navigating to ${normalizedPath}...`).start();

        try {
          await page.goto(targetUrl, { timeout: 30000 });
          pageSpinner.text = `    Waiting for network idle on ${normalizedPath}...`;
          await page.waitForLoadState('networkidle', { timeout: 15000 });
          
          // Wait a brief moment for layout/dynamic scripts to settle
          await new Promise(resolve => setTimeout(resolve, 500));

          pageSpinner.text = `    Saving screenshot ${filename}...`;
          await page.screenshot({ path: outputPath, fullPage: false });
          pageSpinner.succeed(pc.green(`   ✔ Saved ${filename}`));
        } catch (err) {
          pageSpinner.fail(pc.red(`   ✘ Failed to capture ${normalizedPath}: ${err.message}`));
        }
      }

      await context.close();
    }
  }

  await browser.close();
  console.log(pc.bold(pc.green(`\n🎉 Selesai! Semua tangkapan layar disimpan di '${outputDir}'.`)));
}

program
  .name('mobile-snap')
  .description('⚡ MobileSnap CLI: Automate App Store & Google Play Store screenshots')
  .version('1.0.0')
  .requiredOption('-u, --url <url>', 'Base URL of the local development server (e.g. localhost:3000)')
  .option('-p, --paths <paths>', 'Comma-separated list of routes to capture', '/')
  .option('-o, --output <output>', 'Output directory to save screenshots', 'mobilesnap_output')
  .option('-l, --platform <platform>', 'Target platform: "ios", "android", or "both"', 'ios')
  .action((options) => {
    const pathList = options.paths.split(',').map(p => p.trim()).filter(Boolean);
    const finalPaths = pathList.length ? pathList : ['/'];
    
    const platformVal = options.platform.toLowerCase();
    if (!['ios', 'android', 'both'].includes(platformVal)) {
      console.error(pc.red(`Error: Platform '${options.platform}' tidak valid. Pilih antara 'ios', 'android', atau 'both'.`));
      process.exit(1);
    }

    captureScreenshots(options.url, finalPaths, options.output, platformVal).catch(err => {
      console.error(pc.red(`Terjadi kesalahan tidak terduga: ${err.message}`));
      process.exit(1);
    });
  });

program.parse(process.argv);
