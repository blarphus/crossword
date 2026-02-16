#!/usr/bin/env python3
"""Parse downloaded xwordinfo HTML files into structured puzzle JSON.

Extracts grid, clues, answers, and metadata directly from the HTML table
and clue divs present in xwordinfo pages.
"""

import json
import os
import re
import sys
from glob import glob

from bs4 import BeautifulSoup

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
PUZZLES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "puzzles")


def parse_file(filepath: str) -> dict | None:
    """Parse a single xwordinfo HTML file into puzzle JSON."""
    with open(filepath, "r", encoding="utf-8") as f:
        html = f.read()

    soup = BeautifulSoup(html, "html.parser")

    # ── Metadata from JSON-LD ──────────────────────────────────────
    author = ""
    editor = ""
    ld_script = soup.find("script", type="application/ld+json")
    if ld_script:
        try:
            ld = json.loads(ld_script.string)
            author = ld.get("author", {}).get("name", "")
            editor = ld.get("editor", {}).get("name", "")
        except (json.JSONDecodeError, AttributeError):
            pass

    # Fallback metadata from aegrid div
    if not author:
        aegrid = soup.find("div", id="CPHContent_AEGrid")
        if aegrid:
            divs = aegrid.find_all("div")
            for i, d in enumerate(divs):
                if d.get_text(strip=True) == "Author:" and i + 1 < len(divs):
                    author = divs[i + 1].get_text(strip=True)
                if d.get_text(strip=True) == "Editor:" and i + 1 < len(divs):
                    editor = divs[i + 1].get_text(strip=True)

    # ── Grid from PuzTable ─────────────────────────────────────────
    table = soup.find("table", id="PuzTable")
    if not table:
        return None

    grid = []
    cell_numbers = []

    for tr in table.find_all("tr"):
        row_letters = []
        row_nums = []
        for td in tr.find_all("td"):
            # Black cell: has class "black" or has inline background color
            is_black = "black" in (td.get("class") or [])
            if not is_black and td.get("style") and "background" in td.get("style", ""):
                is_black = True

            if is_black:
                row_letters.append(".")
                row_nums.append(0)
            else:
                letter_div = td.find("div", class_="letter")
                num_div = td.find("div", class_="num")
                letter = letter_div.get_text(strip=True) if letter_div else ""
                num_text = num_div.get_text(strip=True) if num_div else ""
                row_letters.append(letter if letter else ".")
                row_nums.append(int(num_text) if num_text else 0)

        if row_letters:
            grid.append(row_letters)
            cell_numbers.append(row_nums)

    if not grid:
        return None

    rows = len(grid)
    cols = len(grid[0]) if grid else 0

    # ── Clues from numclue divs ────────────────────────────────────
    def parse_clue_section(panel_id: str) -> list:
        clues = []
        panel = soup.find("div", id=panel_id)
        if not panel:
            return clues

        numclue = panel.find("div", class_="numclue")
        if not numclue:
            return clues

        # Children are alternating: <div>number</div><div>clue : ANSWER</div>
        children = [c for c in numclue.children if getattr(c, "name", None) == "div"]
        for i in range(0, len(children) - 1, 2):
            num_text = children[i].get_text(strip=True)
            clue_div = children[i + 1]

            if not num_text.isdigit():
                continue
            num = int(num_text)

            # Extract answer from Finder link, then remove it from the div
            answer = ""
            link = clue_div.find("a", href=re.compile(r"/Finder\?w="))
            if link:
                m = re.search(r"/Finder\?w=(\w+)", link.get("href", ""))
                if m:
                    answer = m.group(1).upper()
                link.decompose()  # remove the link so it doesn't appear in clue text

            # Get clue text (answer link already removed)
            clue_text = clue_div.get_text(strip=True)
            # Strip trailing " :" left after removing the answer link
            clue_text = re.sub(r"\s*:\s*$", "", clue_text)

            clues.append({"number": num, "clue": clue_text, "answer": answer})

        return clues

    across_clues = parse_clue_section("ACluesPan")
    down_clues = parse_clue_section("DCluesPan")

    if not across_clues and not down_clues:
        return None

    # ── Map clue numbers to grid positions ─────────────────────────
    num_pos = {}
    for r in range(rows):
        for c in range(cols):
            if cell_numbers[r][c] > 0:
                num_pos[cell_numbers[r][c]] = (r, c)

    for clue in across_clues:
        if clue["number"] in num_pos:
            clue["row"], clue["col"] = num_pos[clue["number"]]

    for clue in down_clues:
        if clue["number"] in num_pos:
            clue["row"], clue["col"] = num_pos[clue["number"]]

    # ── Extract date from filename ─────────────────────────────────
    basename = os.path.basename(filepath)
    date_str = basename.replace(".html", "")

    # ── Day of week from title ─────────────────────────────────────
    title_el = soup.find("h1", id="PuzTitle")
    title = title_el.get_text(strip=True) if title_el else ""

    return {
        "date": date_str,
        "title": title,
        "author": author,
        "editor": editor,
        "dimensions": {"rows": rows, "cols": cols},
        "grid": grid,
        "cellNumbers": cell_numbers,
        "clues": {
            "across": across_clues,
            "down": down_clues,
        },
    }


def main():
    os.makedirs(PUZZLES_DIR, exist_ok=True)
    base_dir = os.path.dirname(os.path.abspath(__file__))

    html_files = sorted(glob(os.path.join(DATA_DIR, "*.html")))
    if not html_files:
        print(f"No HTML files found in {DATA_DIR}/")
        print("Run download.py first to fetch crossword pages.")
        sys.exit(1)

    print(f"Found {len(html_files)} HTML files to parse\n")

    success = 0
    failed = 0
    all_puzzles = {}

    for filepath in html_files:
        basename = os.path.basename(filepath)
        date_str = basename.replace(".html", "")
        print(f"  [{date_str}] Parsing ... ", end="", flush=True)

        try:
            result = parse_file(filepath)
            if result:
                out_path = os.path.join(PUZZLES_DIR, f"{date_str}.json")
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(result, f, indent=2, ensure_ascii=False)
                n_across = len(result["clues"]["across"])
                n_down = len(result["clues"]["down"])
                print(f"OK ({n_across}A + {n_down}D clues, {result['dimensions']['rows']}x{result['dimensions']['cols']})")
                all_puzzles[date_str] = result
                success += 1
            else:
                print("FAILED: could not extract puzzle data")
                failed += 1
        except Exception as e:
            print(f"FAILED: {e}")
            failed += 1

    # Write puzzles.js for the webapp (works with file:// protocol)
    js_path = os.path.join(base_dir, "puzzles.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("// Auto-generated by parse.py — all puzzle data for the webapp\n")
        f.write("const ALL_PUZZLES = ")
        json.dump(all_puzzles, f, ensure_ascii=False)
        f.write(";\n")
    print(f"\nWrote {js_path} ({len(all_puzzles)} puzzles)")

    print(f"Done: {success} parsed, {failed} failed")


if __name__ == "__main__":
    main()
