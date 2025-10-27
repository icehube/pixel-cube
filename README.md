## Cube Card Gallery Generator

This personal tool converts a cube list (for example `cards.txt`) into a visual HTML gallery that pulls the latest Magic: The Gathering data directly from the [Scryfall API](https://scryfall.com/docs/api).

### Quick start

1. Install dependencies (only the Node runtime is required, no external packages).
2. From the repository root, run:

   ```bash
   npm run generate -- path/to/list.txt
   ```

   - The script writes an HTML file to `dist/<list-name>.html`.
   - Provide a second argument to override the output file, e.g.:

     ```bash
     npm run generate -- white.txt /tmp/my-gallery.html
     ```

3. Open the generated HTML file in a browser. The page renders an eight-column grid that lazy-loads card data from the accompanying JSON file. Use the color-identity checkboxes, the “Show lands” toggle, and the sort dropdown (mana value ↑/↓ or color) to explore the list. Each card lists only post-2004 printings, with their symbols served from `dist/assets/set-icons`, and card art loaded from `dist/assets/card-images`, so the page can be viewed offline without re-querying Scryfall.
4. Use the “Cards printed in 2024+” checkbox, Ownership/Rarity dropdowns, and the Set filter dropdown to focus on specific subsets (e.g., only unchecked Mythics from a particular release). When you want the list of cards you’ve checked off, hit the “Download Selected” button to export the selection from Supabase (or from local storage if Supabase credentials aren’t configured).

### Appending more cards

- Additional list files can be merged into the existing gallery (for example, `cards-1.txt` will append to `dist/cards.json` / `dist/cards.html`). Just run:

  ```bash
  npm run generate -- cards-1.txt
  ```

- Cards introduced by a later run are tagged with a `NEW` badge so they’re easy to spot. Existing entries keep their previous data, and rerunning the same file simply refreshes those records without duplicating them.
- To regenerate the HTML/CSS without re-importing data, re-run the command with `--render-only` (e.g. `npm run generate -- cards.txt --render-only`). This reuses the cached `dist/cards.json` and only rewrites the HTML shell.
- Card selections are sticky: every card row now has a checkbox, and the “Copy Selected” button grabs the checked card names to your clipboard. Selections persist automatically via `localStorage`, so each device remembers its own picks.
- Optional cloud sync: if you want selections to follow you across devices, deploy a Supabase Edge Function (see [Supabase CORS guide](https://supabase.com/docs/guides/functions/cors)) and set these env vars **before running the generator** (or add them to Cloudflare Pages → Settings → Environment variables):

  ```bash
  REMOTE_STORE_URL="https://your-project.functions.supabase.co/selection-sync" \
  REMOTE_STORE_KEY="your-service-role-key" \
  REMOTE_STORE_TABLE="card_selections" \
  REMOTE_STORE_PROFILE="your-unique-profile-id" \
  npm run generate -- cards.txt
  ```

  Create a table `card_selections(profile_id text, card_name text)` and add a composite primary key on `(profile_id, card_name)`. The client will read/write via Supabase’s REST API (DELETE + bulk INSERT), while still falling back to local storage if the network call fails.

### Deploying to Cloudflare Pages

1. Push this repository to GitHub (or any supported Git provider) and create a Cloudflare Pages project pointing at it.
2. Set the build command to `npm run build` and the build output directory to `dist`.
3. Add your Supabase credentials (or leave them blank to keep selections local) in *Pages → Settings → Environment variables* using the same keys shown above.
4. Each deploy will run the generator during the build step, produce `dist/cards.html` plus the `assets/` folder, and host them on Cloudflare’s edge network. For quick UI-only tweaks, you can run `npm run render` locally and commit the refreshed `dist` output, or trigger a Pages redeploy with `--render-only` if you don’t need to re-import data.

### Input format

- Each row in the list file must be tab-delimited.
- Column 1: Card name (exact Scryfall name).
- Column 3: Cube count (displayed on the card tile).
- Additional columns are ignored.

### Notes

- The script reaches out to Scryfall for card data, every printing, the set catalog, card art, and set symbols. The first run against a large list can take a few minutes while it caches everything locally.
- Set symbols live in `dist/assets/set-icons` and full-size card images live in `dist/assets/card-images`. Both are only downloaded once per card/set.
- Each HTML gallery writes a sibling JSON data file (same basename) that the UI fetches on load, keeping the HTML itself light even for ~2k cards.
- A cached copy of the set catalog is stored at `.cache/scryfall-sets.json` (regenerated automatically if it’s older than a week).
- If the script cannot resolve a specific card, it logs a warning and continues with the rest of the list.
- Filenames that end with `-<number>` automatically append to the base dataset (e.g. `cards-1.txt` updates `dist/cards.*`).
- Selection state defaults to `localStorage`; if Supabase credentials are supplied during generation the gallery will sync checkboxes across devices using the configured profile id.
