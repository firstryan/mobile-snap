from setuptools import setup, find_packages

setup(
    name="mobilesnap",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "typer>=0.9.0",
        "playwright>=1.40.0",
        "rich>=13.0.0",
    ],
    entry_points={
        "console_scripts": [
            "mobilesnap=mobilesnap.main:app",
        ],
    },
    python_requires=">=3.8",
)
