import asyncio
import os
import re
from enum import Enum
from pathlib import Path
from typing import List, Optional
import typer
from playwright.async_api import async_playwright, Error as PlaywrightError
from rich.console import Console

# Initialize Typer app and Rich Console
app = typer.Typer(
    name="mobilesnap",
    help="⚡ MobileSnap: Automate pixel-precise App Store & Google Play screenshots from local web servers.",
    add_completion=False,
)
console = Console()


# Enum for Platform choices
class Platform(str, Enum):
    ios = "ios"
    android = "android"
    both = "both"


# Device configurations grouped by platform
DEVICE_CONFIGS = {
    "ios": {
        "devices": {
            "6.7_inch": {"width": 1290, "height": 2796},
            "6.5_inch": {"width": 1242, "height": 2688},
        },
        "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    },
    "android": {
        "devices": {
            "android_phone": {"width": 1080, "height": 2400},
            "android_tablet": {"width": 1600, "height": 2560},
        },
        "user_agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
    },
}


def safe_filename(path: str) -> str:
    """Converts a URL path into a safe, descriptive file name snippet."""
    # Strip leading/trailing slashes
    clean_path = path.strip("/")
    if not clean_path:
        return "home"
    # Replace non-alphanumeric characters with underscores
    clean_path = re.sub(r"[^a-zA-Z0-9_\-]", "_", clean_path)
    # Replace multiple consecutive underscores with a single one
    clean_path = re.sub(r"_+", "_", clean_path)
    return clean_path.strip("_")


async def capture_screenshots(url: str, paths: List[str], output_dir: Path, platform: Platform):
    """Core async capture logic using Playwright."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # Normalize url (ensure it has a scheme)
    if not url.startswith(("http://", "https://")):
        url = "http://" + url
    url = url.rstrip("/")

    # Determine which platforms to target
    if platform == Platform.both:
        target_platforms = ["ios", "android"]
    else:
        target_platforms = [platform.value]

    console.print(f"[bold blue]Starting MobileSnap screenshot automation...[/bold blue]")
    console.print(f"Target Server: [cyan]{url}[/cyan]")
    console.print(f"Platform(s): [cyan]{', '.join(target_platforms).upper()}[/cyan]")
    console.print(f"Output Directory: [cyan]{output_dir.resolve()}[/cyan]\n")

    async with async_playwright() as p:
        # Launch headless Chromium
        with console.status("[yellow]Launching Chromium browser...[/yellow]") as status:
            try:
                browser = await p.chromium.launch(headless=True)
            except Exception as e:
                console.print(f"[bold red]Failed to launch Chromium browser: {e}[/bold red]")
                raise typer.Exit(code=1)

        # Loop through each target platform
        for plat in target_platforms:
            config = DEVICE_CONFIGS[plat]
            user_agent = config["user_agent"]
            devices = config["devices"]

            console.print(f"[bold blue]💻 Platform: {plat.upper()}[/bold blue]")

            for device_name, size in devices.items():
                width, height = size["width"], size["height"]
                console.print(f"  [bold magenta]📱 Processing {device_name} ({width}x{height}px)...[/bold magenta]")

                # Set up context
                context = await browser.new_context(
                    viewport={"width": width, "height": height},
                    user_agent=user_agent,
                    device_scale_factor=3,  # High DPI for crisp screenshots
                    is_mobile=True,
                    has_touch=True,
                )

                page = await context.new_page()

                for path in paths:
                    normalized_path = "/" + path.lstrip("/")
                    target_url = f"{url}{normalized_path}"
                    name_snippet = safe_filename(normalized_path)
                    filename = f"{device_name}_{name_snippet}.png"
                    output_path = output_dir / filename

                    with console.status(f"    Navigating to {normalized_path}...") as status:
                        try:
                            await page.goto(target_url, timeout=30000)
                            status.update(f"    Waiting for network idle on {normalized_path}...")
                            await page.wait_for_load_state("networkidle", timeout=15000)
                            await asyncio.sleep(0.5)

                            status.update(f"    Saving screenshot {filename}...")
                            await page.screenshot(path=str(output_path), full_page=False)

                            console.print(
                                f"    [green]✔[/green] Saved [bold green]{filename}[/bold green]"
                            )
                        except PlaywrightError as err:
                            console.print(
                                f"    [red]✘[/red] Failed to capture [cyan]{normalized_path}[/cyan]: {err.message}"
                            )
                        except Exception as err:
                            console.print(
                                f"    [red]✘[/red] Error on [cyan]{normalized_path}[/cyan]: {err}"
                            )

                await context.close()

        await browser.close()
    
    console.print(f"\n[bold green]🎉 Selesai! Semua tangkapan layar disimpan di '{output_dir}'.[/bold green]")


@app.command()
def main(
    url: str = typer.Option(
        ...,
        "--url",
        "-u",
        help="Base URL of the local development server (e.g., localhost:3000 or http://127.0.0.1:4321)",
    ),
    paths: str = typer.Option(
        "/",
        "--paths",
        "-p",
        help="Comma-separated list of paths/routes to capture (e.g., '/, /scan, /profile')",
    ),
    output: Path = typer.Option(
        Path("mobilesnap_output"),
        "--output",
        "-o",
        help="Output directory to save the screenshots",
    ),
    platform: Platform = typer.Option(
        Platform.ios,
        "--platform",
        "-l",
        help="Target platform: 'ios', 'android', or 'both'",
    ),
):
    """
    ⚡ MobileSnap CLI: Generate pixel-precise App Store & Google Play screenshots from a local web server automatically.
    """
    # Parse paths from comma-separated string
    path_list = [p.strip() for p in paths.split(",") if p.strip()]
    if not path_list:
        path_list = ["/"]

    try:
        # Run the async core loop
        asyncio.run(capture_screenshots(url=url, paths=path_list, output_dir=output, platform=platform))
    except Exception as e:
        console.print(f"[bold red]An unexpected error occurred during execution: {e}[/bold red]")
        raise typer.Exit(code=1)


if __name__ == "__main__":
    app()

