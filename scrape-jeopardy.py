#!/usr/bin/env python3
"""
J-Archive Scraper — scrapes 1000 recent games by game_id range.

Uses get_text(separator=' ') to preserve spaces between inline HTML elements.

Usage:
    pip install requests beautifulsoup4
    python scrape-jeopardy.py              # full scrape (game_ids 8383-9382)
    python scrape-jeopardy.py --test       # test with 3 games only
"""

import requests
from bs4 import BeautifulSoup
import json
import time
import re
import os
import sys
from datetime import datetime

BASE_URL = "https://j-archive.com"
OUTPUT_FILE = "jeopardy-scraped.json"
PROGRESS_FILE = "jeopardy-scrape-progress.json"

# Game ID range: latest 1000 games
START_ID = 8383
END_ID = 9382

# Test game IDs
TEST_IDS = [9382, 7424, 8500]


def clean_html_text(element):
    """
    Extract text from an element, preserving spaces between inline elements.
    Uses separator=' ' so <i>, <b>, <a> etc. don't concatenate without spaces.
    Then normalizes multiple spaces.
    """
    if element is None:
        return ""
    text = element.get_text(separator=' ')
    return ' '.join(text.split()).strip()


def scrape_game(game_id):
    """Scrape a single game from j-archive."""
    url = f"{BASE_URL}/showgame.php?game_id={game_id}"

    response = requests.get(url, timeout=30)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, 'html.parser')

    game = {
        'gameId': str(game_id),
        'showNumber': '',
        'airDate': '',
        'jRound': {'categories': [], 'clues': []},
        'djRound': {'categories': [], 'clues': []},
        'fj': {'category': '', 'clue': '', 'answer': ''}
    }

    # Extract show number and air date from title
    title = soup.title.string if soup.title else ''
    match = re.search(r'Show #(\d+).*aired (\d{4}-\d{2}-\d{2})', title)
    if match:
        game['showNumber'] = match.group(1)
        game['airDate'] = match.group(2)

    # Jeopardy Round
    j_round = soup.find(id='jeopardy_round')
    if j_round:
        for cat in j_round.find_all('td', class_='category_name'):
            game['jRound']['categories'].append(clean_html_text(cat))

        for col in range(1, 7):
            for row in range(1, 6):
                clue_el = soup.find(id=f'clue_J_{col}_{row}')
                ans_el = soup.find(id=f'clue_J_{col}_{row}_r')

                if clue_el and clue_el.get_text(strip=True):
                    answer = ''
                    if ans_el:
                        correct = ans_el.find('em', class_='correct_response')
                        if correct:
                            answer = clean_html_text(correct)

                    is_dd = False
                    clue_container = clue_el.find_parent('td', class_='clue')
                    if clue_container and clue_container.find(class_='clue_value_daily_double'):
                        is_dd = True

                    clue_data = {
                        'cat': col - 1,
                        'row': row,
                        'value': row * 200,
                        'clue': clean_html_text(clue_el),
                        'answer': answer
                    }
                    if is_dd:
                        clue_data['dailyDouble'] = True

                    game['jRound']['clues'].append(clue_data)

    # Double Jeopardy Round
    dj_round = soup.find(id='double_jeopardy_round')
    if dj_round:
        for cat in dj_round.find_all('td', class_='category_name'):
            game['djRound']['categories'].append(clean_html_text(cat))

        for col in range(1, 7):
            for row in range(1, 6):
                clue_el = soup.find(id=f'clue_DJ_{col}_{row}')
                ans_el = soup.find(id=f'clue_DJ_{col}_{row}_r')

                if clue_el and clue_el.get_text(strip=True):
                    answer = ''
                    if ans_el:
                        correct = ans_el.find('em', class_='correct_response')
                        if correct:
                            answer = clean_html_text(correct)

                    is_dd = False
                    clue_container = clue_el.find_parent('td', class_='clue')
                    if clue_container and clue_container.find(class_='clue_value_daily_double'):
                        is_dd = True

                    clue_data = {
                        'cat': col - 1,
                        'row': row,
                        'value': row * 400,
                        'clue': clean_html_text(clue_el),
                        'answer': answer
                    }
                    if is_dd:
                        clue_data['dailyDouble'] = True

                    game['djRound']['clues'].append(clue_data)

    # Final Jeopardy
    fj_round = soup.find(id='final_jeopardy_round')
    if fj_round:
        fj_cat = fj_round.find('td', class_='category_name')
        if fj_cat:
            game['fj']['category'] = clean_html_text(fj_cat)

        fj_clue = soup.find(id='clue_FJ')
        if fj_clue:
            game['fj']['clue'] = clean_html_text(fj_clue)

        fj_ans = soup.find(id='clue_FJ_r')
        if fj_ans:
            correct = fj_ans.find('em', class_='correct_response')
            if correct:
                game['fj']['answer'] = clean_html_text(correct)

    return game


def count_clues(game):
    """Count total clues in a game."""
    count = len(game['jRound']['clues']) + len(game['djRound']['clues'])
    if game['fj']['clue']:
        count += 1
    return count


def load_progress():
    """Load scrape progress for resume capability."""
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, 'r') as f:
            return json.load(f)
    return {'completed_ids': [], 'games': []}


def save_progress(progress):
    """Save scrape progress."""
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(progress, f)


def run_test():
    """Test scrape with 3 specific games."""
    print("=" * 60)
    print("TEST MODE — scraping 3 games")
    print("=" * 60)

    for gid in TEST_IDS:
        print(f"\nScraping game {gid}...", end=' ', flush=True)
        try:
            game = scrape_game(gid)
            clues = count_clues(game)
            print(f"OK (Show #{game['showNumber']}, {game['airDate']}, {clues} clues)")

            # For game 7424, check specific clues for spacing
            if gid == 7424:
                print("\n  Checking game 7424 for spacing issues...")
                j_clues = game['jRound']['clues']
                for c in j_clues:
                    if c['cat'] == 0 and c['row'] == 1:
                        print(f"    [0,1] clue: {c['clue'][:80]}")
                        print(f"    [0,1] answer: {c['answer']}")
                    if c['cat'] == 4 and c['row'] == 1:
                        print(f"    [4,1] clue: {c['clue'][:80]}")
                        print(f"    [4,1] answer: {c['answer']}")

            # Print a sample clue
            if game['jRound']['clues']:
                sample = game['jRound']['clues'][0]
                print(f"  Sample J clue: {sample['clue'][:80]}")
                print(f"  Sample J answer: {sample['answer']}")
            if game['fj']['clue']:
                print(f"  FJ category: {game['fj']['category']}")
                print(f"  FJ clue: {game['fj']['clue'][:80]}")
                print(f"  FJ answer: {game['fj']['answer']}")

        except Exception as e:
            print(f"ERROR: {e}")

        time.sleep(0.5)

    print("\nTest complete!")


def run_full_scrape():
    """Scrape all 1000 games."""
    print("=" * 60)
    print(f"FULL SCRAPE — game_ids {START_ID} to {END_ID}")
    print("=" * 60)
    print(f"Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    progress = load_progress()
    completed = set(progress['completed_ids'])
    games = progress['games']

    all_ids = list(range(START_ID, END_ID + 1))
    remaining = [gid for gid in all_ids if gid not in completed]

    print(f"Already scraped: {len(completed)}, remaining: {len(remaining)}")

    failed = []
    for i, gid in enumerate(remaining):
        print(f"  [{len(completed) + i + 1}/{len(all_ids)}] Game {gid}...", end=' ', flush=True)
        try:
            game = scrape_game(gid)
            if len(game['jRound']['clues']) > 0:
                games.append(game)
                completed.add(gid)
                clues = count_clues(game)
                print(f"OK (Show #{game['showNumber']}, {clues} clues)")
            else:
                print("SKIPPED (no clues)")
                completed.add(gid)  # mark as done so we don't retry

            # Save progress every 25 games
            if (i + 1) % 25 == 0:
                progress['completed_ids'] = list(completed)
                progress['games'] = games
                save_progress(progress)
                print(f"  [progress saved: {len(games)} games]")

        except Exception as e:
            print(f"ERROR: {e}")
            failed.append(gid)
            time.sleep(1)

        time.sleep(0.5)

    # Save final output
    progress['completed_ids'] = list(completed)
    progress['games'] = games
    save_progress(progress)

    # Sort by air date and write final output
    games.sort(key=lambda g: g.get('airDate', ''))
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(games, f, indent=2, ensure_ascii=False)

    total_clues = sum(count_clues(g) for g in games)
    print(f"\n{'=' * 60}")
    print(f"SCRAPE COMPLETE")
    print(f"{'=' * 60}")
    print(f"Games scraped: {len(games)}")
    print(f"Total clues: {total_clues}")
    print(f"Failed IDs: {failed if failed else 'None'}")
    print(f"Output: {OUTPUT_FILE}")
    print(f"Finished at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")


if __name__ == '__main__':
    if '--test' in sys.argv:
        run_test()
    else:
        run_full_scrape()
