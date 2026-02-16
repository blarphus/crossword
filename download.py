#!/usr/bin/env python3
"""Download crossword pages from xwordinfo.com for the past 30 days."""

import os
import time
import random
from datetime import date, timedelta

import requests

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
BASE_URL = "https://www.xwordinfo.com/Crossword"
DAYS_BACK = 5 * 365
DELAY_MIN = 1.0
DELAY_MAX = 1.5

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    today = date.today()
    start_date = today - timedelta(days=DAYS_BACK)
    end_date = today - timedelta(days=1)

    print(f"Downloading crosswords from {start_date} to {end_date}")
    print(f"Saving to {DATA_DIR}/\n")

    current = start_date
    downloaded = 0
    skipped = 0

    while current <= end_date:
        filename = f"{current.isoformat()}.html"
        filepath = os.path.join(DATA_DIR, filename)

        if os.path.exists(filepath):
            print(f"  [{current}] Already exists, skipping")
            skipped += 1
            current += timedelta(days=1)
            continue

        # Format date as M/D/YYYY for the URL
        url_date = f"{current.month}/{current.day}/{current.year}"
        url = f"{BASE_URL}?date={url_date}"

        print(f"  [{current}] Fetching {url} ... ", end="", flush=True)

        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()

            with open(filepath, "w", encoding="utf-8") as f:
                f.write(resp.text)

            print(f"OK ({len(resp.text):,} bytes)")
            downloaded += 1

        except requests.RequestException as e:
            print(f"FAILED: {e}")

        current += timedelta(days=1)

        # Rate limit between requests
        if current <= end_date:
            delay = random.uniform(DELAY_MIN, DELAY_MAX)
            time.sleep(delay)

    print(f"\nDone: {downloaded} downloaded, {skipped} skipped")


if __name__ == "__main__":
    main()
