#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const OUT_DIR = "dist";
const CACHE_DIR = ".cache";
const SET_CACHE_FILE = path.join(CACHE_DIR, "scryfall-sets.json");
const SET_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // one week
const IMAGE_PRIORITIES = ["normal", "large", "png", "border_crop", "art_crop", "small"];
const EARLIEST_YEAR = 2004;
const remoteStoreConfig = buildRemoteStoreConfig();

/**
 * Entry point.
 */
(async () => {
  try {
    const cli = parseCliArguments(process.argv.slice(2));
    if (!cli.input) {
      console.error("Usage: node scripts/generate.js <list-file|dataset> [output] [--render-only]");
      process.exit(1);
    }

    const renderOnly = cli.renderOnly;
    const inputPath = path.resolve(process.cwd(), cli.input);
    const sourceIdentifier = renderOnly ? cli.input : inputPath;
    const outputOverride = cli.outputOverride ? path.resolve(process.cwd(), cli.outputOverride) : null;

    if (!renderOnly) {
      try {
        await fs.access(inputPath);
      } catch {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
      }
    }

    const inferredBaseName = outputOverride
      ? path.basename(outputOverride, path.extname(outputOverride))
      : path.basename(sourceIdentifier, path.extname(sourceIdentifier));
    const canonicalBaseName = canonicalizeBaseName(inferredBaseName);
    const outputDir = outputOverride
      ? path.dirname(outputOverride)
      : path.resolve(process.cwd(), OUT_DIR);
    const outputFileName =
      outputOverride
        ? path.basename(outputOverride)
        : canonicalBaseName === "cards"
        ? "index.html"
        : `${canonicalBaseName}.html`;
    const outputPath = outputOverride ?? path.join(outputDir, outputFileName);
    const htmlDir = path.dirname(outputPath);
    const assetsDir = path.join(outputDir, "assets");
    const iconsDir = path.join(assetsDir, "set-icons");
    const cardImagesDir = path.join(assetsDir, "card-images");
    const dataPath = path.join(outputDir, `${canonicalBaseName}.json`);
    const dataRelativePath = path.relative(htmlDir, dataPath).split(path.sep).join("/");
    const colorLabel = deriveColorFromFile(sourceIdentifier);

    await Promise.all([
      fs.mkdir(outputDir, { recursive: true }),
      fs.mkdir(iconsDir, { recursive: true }),
      fs.mkdir(cardImagesDir, { recursive: true }),
      fs.mkdir(path.resolve(process.cwd(), CACHE_DIR), { recursive: true }),
    ]);

    if (renderOnly) {
      let datasetString;
      try {
        datasetString = await fs.readFile(dataPath, "utf8");
      } catch {
        throw new Error(`No existing dataset found at ${dataPath}. Run without --render-only first.`);
      }

      const outputHtml = renderHtml({
        colorLabel,
        sourceFileName: path.basename(sourceIdentifier),
        dataPath: dataRelativePath,
        datasetString,
        datasetKey: canonicalBaseName,
        remoteStoreConfig,
      });

      await fs.writeFile(outputPath, outputHtml, "utf8");
      console.log(`Gallery rendered from existing data: ${outputPath}`);
      return;
    }

    const fileLines = await loadListFile(inputPath);
    const parsedEntries = parseEntries(fileLines);
    if (!parsedEntries.length) {
      throw new Error(`No card entries were found in ${inputPath}`);
    }

    const setDirectory = await loadSetDirectory();

    const totalCards = parsedEntries.length;
    let processedCards = 0;
    let existingCards = [];
    try {
      const existingRaw = await fs.readFile(dataPath, "utf8");
      const parsedExisting = JSON.parse(existingRaw);
      if (Array.isArray(parsedExisting?.cards)) {
        existingCards = parsedExisting.cards;
      }
    } catch {
      existingCards = [];
    }

    const newCards = [];
    process.stdout.write(`Fetching data for ${totalCards} cards...\n`);

    for (const entry of parsedEntries) {
      try {
        const card = await fetchPrimaryCard(entry.name);
        if (hasFlavorName(card)) {
          console.log(`Skipping "${entry.name}" (flavor_name present).`);
          continue;
        }
        const prints = await fetchAllPrints(card);
        const setDetails = await buildSetDetails(prints, setDirectory, {
          iconsDir,
          relativeTo: htmlDir,
        });
        const remoteImageUri = selectImageUri(card, prints);
        const imagePath = await ensureCardImageFile(card, remoteImageUri, {
          cardImagesDir,
          relativeTo: htmlDir,
        });

        newCards.push({
          name: entry.name,
          cubeCount: entry.cubeCount,
          imagePath,
          remoteImageUri,
          scryfallUri: card.scryfall_uri,
          typeLine: card.type_line ?? "",
          manaCost: card.mana_cost ?? "",
          manaValue: deriveManaValue(card),
          colorIdentity: Array.isArray(card.color_identity) ? card.color_identity : [],
          setPrintings: setDetails,
        });
      } catch (err) {
        console.warn(`Failed to fetch data for "${entry.name}": ${err.message}`);
      }
      processedCards += 1;
      reportProgress(processedCards, totalCards);
    }
    process.stdout.write("\n");

    if (!newCards.length && !existingCards.length) {
      throw new Error("Unable to resolve data for any cards. No output generated.");
    }

    const mergedCards = mergeCards(existingCards, newCards);

    const dataset = {
      generatedAt: new Date().toISOString(),
      sourceFile: path.basename(sourceIdentifier),
      totalCards: mergedCards.length,
      cards: mergedCards,
    };
    const datasetString = JSON.stringify(dataset);
    await fs.writeFile(dataPath, JSON.stringify(dataset, null, 2), "utf8");

    const outputHtml = renderHtml({
      colorLabel,
      sourceFileName: path.basename(sourceIdentifier),
      dataPath: dataRelativePath,
      datasetString,
      datasetKey: canonicalBaseName,
      remoteStoreConfig,
    });

    await fs.writeFile(outputPath, outputHtml, "utf8");
    console.log(`Gallery created: ${outputPath}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();

/**
 * Reads the supplied list file.
 * @param {string} filePath
 * @returns {Promise<string[]>}
 */
async function loadListFile(filePath) {
  const file = await fs.readFile(filePath, "utf8");
  return file
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Parses the cube list file rows.
 * Expected format: Name<TAB>...<TAB>CubeCount<...>
 * @param {string[]} lines
 * @returns {{ name: string; cubeCount: string }[]}
 */
function parseEntries(lines) {
  return lines
    .map((line) => line.split(/\t+/))
    .filter((parts) => parts.length >= 3)
    .map((parts) => ({
      name: parts[0].trim(),
      cubeCount: parts[2].trim(),
    }));
}

/**
 * Derives the color label from the filename.
 * @param {string} filePath
 */
function deriveColorFromFile(filePath) {
  const raw = path.basename(filePath, path.extname(filePath));
  return raw.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim() || "Unknown";
}

/**
 * Fetches the canonical card object for the supplied name.
 * @param {string} cardName
 */
async function fetchPrimaryCard(cardName) {
  const query = encodeURIComponent(cardName);
  const resp = await fetch(`https://api.scryfall.com/cards/named?exact=${query}`);
  if (!resp.ok) {
    throw new Error(`Scryfall lookup failed (${resp.status})`);
  }
  const data = await resp.json();
  if (data.object === "error") {
    throw new Error(data.details ?? "Unknown Scryfall error");
  }
  return data;
}

/**
 * Fetches every print for the provided card's prints_search_uri.
 * @param {object} card
 */
async function fetchAllPrints(card) {
  if (!card.prints_search_uri) {
    return [card];
  }

  const prints = [];
  let next = card.prints_search_uri;

  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) {
      throw new Error(`Failed to fetch prints (${resp.status})`);
    }
    const payload = await resp.json();
    if (!payload.data) {
      break;
    }
    prints.push(...payload.data);
    next = payload.has_more ? payload.next_page : null;
    // stay friendly with the Scryfall API
    await pause(120);
  }

  return prints.length ? prints : [card];
}

/**
 * Builds metadata for every set/rarity combination the card appears in.
 * Filters out sets released before EARLIEST_YEAR and writes local icon assets.
 * @param {object[]} prints
 * @param {Map<string, object>} setDirectory
 * @param {{ iconsDir: string; htmlPath: string }} assetOptions
 */
async function buildSetDetails(prints, setDirectory, assetOptions) {
  const grouped = new Map();

  for (const print of prints) {
    if (!print.set || !print.set_name) {
      continue;
    }
    const code = print.set.toUpperCase();
    const entry = grouped.get(code) ?? {
      setCode: code,
      setName: print.set_name,
      rarities: new Set(),
      releasedAt: print.released_at ?? null,
      previewCardUri: print.scryfall_uri ?? null,
    };
    if (print.rarity) {
      entry.rarities.add(print.rarity);
    }
    if (!entry.previewCardUri && print.scryfall_uri) {
      entry.previewCardUri = print.scryfall_uri;
    }
    if (!entry.releasedAt && print.released_at) {
      entry.releasedAt = print.released_at;
    }
    grouped.set(code, entry);
  }

  const relativeBase = assetOptions.relativeTo;
  const finalEntries = [];

  for (const entry of grouped.values()) {
    const setInfo = setDirectory.get(entry.setCode) ?? null;
    const releasedAt = setInfo?.released_at ?? entry.releasedAt ?? null;
    if (releasedAt) {
      const releaseYear = new Date(releasedAt).getFullYear();
      if (Number.isFinite(releaseYear) && releaseYear < EARLIEST_YEAR) {
        continue;
      }
    }

    let iconPath = null;
    const iconUri = setInfo?.icon_svg_uri ?? null;
    if (iconUri) {
      const localIcon = await ensureSetIconFile(entry.setCode, iconUri, assetOptions.iconsDir);
      if (localIcon) {
        iconPath = path.relative(relativeBase, localIcon).split(path.sep).join("/");
      }
    }

    finalEntries.push({
      setCode: entry.setCode,
      setName: entry.setName,
      rarities: Array.from(entry.rarities),
      releasedAt,
      iconPath,
      previewCardUri: entry.previewCardUri,
    });
  }

  return finalEntries.sort(sortSetEntries);
}

/**
 * Ensures a local copy of the set icon exists and returns its absolute path.
 * @param {string} setCode
 * @param {string} iconUri
 * @param {string} iconsDir
 * @returns {Promise<string|null>}
 */
async function ensureSetIconFile(setCode, iconUri, iconsDir) {
  try {
    const url = new URL(iconUri);
    const ext = path.extname(url.pathname) || ".svg";
    const safeCode = setCode.toLowerCase();
    const fileName = `${safeCode}${ext}`;
    const destPath = path.join(iconsDir, fileName);

    try {
      await fs.access(destPath);
      return destPath;
    } catch {
      // continue to download
    }

    const resp = await fetch(iconUri);
    if (!resp.ok) {
      console.warn(`Failed to download icon for ${setCode} (${resp.status})`);
      return null;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    await fs.writeFile(destPath, buffer);
    await pause(100);
    return destPath;
  } catch (error) {
    console.warn(`Unable to cache icon for ${setCode}: ${error.message}`);
    return null;
  }
}

async function ensureCardImageFile(card, imageUri, options) {
  const { cardImagesDir, relativeTo } = options;
  if (!imageUri) {
    return null;
  }
  try {
    const url = new URL(imageUri);
    const ext = path.extname(url.pathname) || ".jpg";
    const safeId = (card.id ?? slugify(card.name)).replace(/[^a-z0-9-]/gi, "_");
    const fileName = `${safeId}${ext}`;
    const destPath = path.join(cardImagesDir, fileName);

    try {
      await fs.access(destPath);
    } catch {
      const resp = await fetch(imageUri);
      if (!resp.ok) {
        console.warn(`Failed to download card image for ${card.name} (${resp.status})`);
        return null;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      await fs.writeFile(destPath, buffer);
      await pause(80);
    }

    return path.relative(relativeTo, destPath).split(path.sep).join("/");
  } catch (error) {
    console.warn(`Unable to cache image for ${card.name}: ${error.message}`);
    return null;
  }
}

/**
 * Creates an in-memory lookup of Scryfall sets (with caching).
 */
async function loadSetDirectory() {
  const cachePath = path.resolve(process.cwd(), SET_CACHE_FILE);
  let cachedData = null;

  try {
    const stat = await fs.stat(cachePath);
    if (Date.now() - stat.mtimeMs <= SET_CACHE_MAX_AGE_MS) {
      const raw = await fs.readFile(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.data)) {
        cachedData = parsed.data;
      }
    }
  } catch {
    // cache miss or unreadable cache
  }

  if (!cachedData) {
    try {
      cachedData = await fetchAllSets();
      const payload = {
        fetchedAt: new Date().toISOString(),
        data: cachedData,
      };
      await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), "utf8");
    } catch (error) {
      console.warn(`Failed to refresh set directory: ${error.message}`);
      cachedData = [];
    }
  }

  const directory = new Map();
  for (const set of cachedData) {
    if (!set || !set.code) {
      continue;
    }
    directory.set(String(set.code).toUpperCase(), set);
  }
  return directory;
}

/**
 * Fetches the complete set list from Scryfall.
 */
async function fetchAllSets() {
  const results = [];
  let next = "https://api.scryfall.com/sets";

  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) {
      throw new Error(`Failed to fetch set catalog (${resp.status})`);
    }
    const payload = await resp.json();
    if (Array.isArray(payload.data)) {
      results.push(...payload.data);
    }
    next = payload.has_more ? payload.next_page : null;
    await pause(120);
  }

  return results;
}

/**
 * Selects a suitable image URI from card data.
 * @param {object} primary
 * @param {object[]} prints
 */
function selectImageUri(primary, prints) {
  const lookup = [...(primary.card_faces ?? []), primary, ...(prints ?? [])];
  for (const candidate of lookup) {
    if (candidate.image_uris) {
      for (const size of IMAGE_PRIORITIES) {
        if (candidate.image_uris[size]) {
          return candidate.image_uris[size];
        }
      }
    }
    if (candidate.card_faces) {
      for (const face of candidate.card_faces) {
        if (face.image_uris) {
          for (const size of IMAGE_PRIORITIES) {
            if (face.image_uris[size]) {
              return face.image_uris[size];
            }
          }
        }
      }
    }
  }
  return primary.scryfall_uri ?? "";
}

function hasFlavorName(card) {
  if (card.flavor_name) {
    return true;
  }
  if (Array.isArray(card.card_faces)) {
    return card.card_faces.some((face) => Boolean(face.flavor_name));
  }
  return false;
}

/**
 * Determines the mana value (CMC) for the given card.
 * @param {object} card
 */
function deriveManaValue(card) {
  if (typeof card.cmc === "number" && Number.isFinite(card.cmc)) {
    return card.cmc;
  }
  if (typeof card.mana_value === "number" && Number.isFinite(card.mana_value)) {
    return card.mana_value;
  }
  return Number.POSITIVE_INFINITY;
}

function mergeCards(existingCards, newCards) {
  const map = new Map();
  const hadExisting = existingCards.length > 0;

  for (const card of existingCards) {
    map.set(cardKey(card), card);
  }

  for (const card of newCards) {
    const key = cardKey(card);
    const previous = map.get(key);
    const isNew = previous ? Boolean(previous.isNew) : hadExisting;
    map.set(key, { ...card, isNew });
  }

  const merged = Array.from(map.values());
  merged.sort(sortByManaThenName);
  return merged;
}

function cardKey(card) {
  return slugify(card.name).toLowerCase();
}

function sortByManaThenName(a, b) {
  const manaDelta =
    (a.manaValue ?? Number.POSITIVE_INFINITY) - (b.manaValue ?? Number.POSITIVE_INFINITY);
  if (manaDelta !== 0) {
    return manaDelta;
  }
  return a.name.localeCompare(b.name);
}

/**
 * Sort helper for set entries (newest first then code).
 */
function sortSetEntries(a, b) {
  if (a.releasedAt && b.releasedAt && a.releasedAt !== b.releasedAt) {
    return new Date(b.releasedAt) - new Date(a.releasedAt);
  }
  return a.setCode.localeCompare(b.setCode);
}

/**
 * Renders the final HTML document.
 * @param {Array} cards
 * @param {string} colorLabel
 * @param {string} sourceFileName
 */
function renderHtml({ colorLabel, sourceFileName, dataPath, datasetString, datasetKey, remoteStoreConfig }) {
  const title = `Pixel Cube ${capitalize(colorLabel)}`;
  const generated = new Date().toLocaleString();
  const dataUrl = dataPath.startsWith(".") ? dataPath : `./${dataPath}`;
  const inlineDataset = inlineJson(datasetString);
  const safeDatasetKey = datasetKey || "cards";
  const remoteStorePayload = JSON.stringify(remoteStoreConfig ?? null);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        font-family: "Segoe UI", Tahoma, sans-serif;
        background: #ffffff;
        color: #0f172a;
      }
      body {
        margin: 0;
        padding: 2rem 1rem 3rem;
        background: #f8fafc;
      }
      header {
        margin-bottom: 1.5rem;
      }
      h1 {
        margin: 0 0 0.5rem;
        font-size: 2rem;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 1rem;
      }
      @media (min-width: 1280px) {
        .grid {
          grid-template-columns: repeat(8, minmax(0, 1fr));
        }
      }
      .card {
        background: #ffffff;
        border-radius: 12px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.1);
        border: 1px solid rgba(226, 232, 240, 0.9);
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        margin-bottom: 1.5rem;
        background: #ffffff;
        border: 1px solid rgba(226, 232, 240, 0.9);
        border-radius: 12px;
        padding: 0.75rem 1rem;
      }
      .control {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .control__label {
        font-size: 0.85rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #475569;
      }
      .color-filter {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem 0.75rem;
      }
      .color-filter label {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        font-size: 0.85rem;
        color: #0f172a;
      }
      .color-filter input {
        accent-color: #2563eb;
      }
      .checkbox {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.9rem;
        color: #0f172a;
        margin-top: 0.35rem;
      }
      .checkbox input {
        accent-color: #2563eb;
      }
      .sort-select {
        min-width: 180px;
        padding: 0.35rem 0.5rem;
        border: 1px solid rgba(148, 163, 184, 0.6);
        border-radius: 8px;
        font-size: 0.9rem;
        background: #f8fafc;
        color: #0f172a;
      }
      .copy-button {
        padding: 0.4rem 0.9rem;
        border-radius: 999px;
        border: none;
        background: #2563eb;
        color: #fff;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .copy-button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .card__image {
        display: block;
        border-bottom: 1px solid rgba(226, 232, 240, 0.9);
      }
      .card__image img {
        display: block;
        width: 100%;
        height: auto;
      }
      .card__body {
        padding: 0.75rem 0.85rem 1.25rem;
      }
      .card__name-row {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        margin-bottom: 0.2rem;
      }
      .card__select {
        margin-right: 0.25rem;
      }
      .card__name {
        margin: 0 0 0.35rem;
        font-size: 0.95rem;
      }
      .card__badge {
        font-size: 0.72rem;
        font-weight: 700;
        color: #f97316;
        background: rgba(249, 115, 22, 0.15);
        border: 1px solid rgba(249, 115, 22, 0.4);
        border-radius: 999px;
        padding: 0.05rem 0.45rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }
      .card__mana-line {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0;
        font-size: 0.85rem;
        color: #0f172a;
      }
      .card__meta {
        margin: 0.1rem 0 0;
        font-size: 0.85rem;
        color: #475569;
      }
      .card__meta:first-of-type {
        margin-top: 0;
      }
      .card__mana {
        font-weight: 600;
        color: #1f2937;
      }
      .card__mv {
        font-size: 0.8rem;
        color: #475569;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .card__typeline {
        margin: 0.6rem 0 0;
        font-size: 0.82rem;
        color: #334155;
      }
      .card__sets {
        margin-top: 0.8rem;
      }
      .card__sets-title {
        margin: 0 0 0.45rem;
        font-size: 0.9rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #0f172a;
      }
      .sets-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 0.55rem;
      }
      .set-item {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.4rem 0.55rem;
        background: #f1f5f9;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.3);
      }
      .set-item--empty {
        justify-content: center;
        text-align: center;
      }
      .set-item--empty .set-item__text {
        display: block;
        font-size: 0.74rem;
        color: #64748b;
      }
      .set-item__icon {
        width: 26px;
        height: 26px;
        flex-shrink: 0;
      }
      .set-item__icon img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      .set-item__text {
        display: flex;
        flex-direction: column;
        font-size: 0.75rem;
        line-height: 1.1;
      }
      .set-item__rarities {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem;
        margin-top: 0.25rem;
      }
      .set-item__rarity {
        font-weight: 600;
        font-size: 0.72rem;
      }
      .rarity--common {
        color: #2a2426;
      }
      .rarity--uncommon {
        color: #56839f;
      }
      .rarity--rare {
        color: #a68236;
      }
      .rarity--mythic {
        color: #d34420;
      }
      .rarity--unknown {
        color: #334155;
      }
      .notice {
        font-size: 0.85rem;
        color: #64748b;
        margin: 0;
      }
      a {
        color: #2563eb;
      }
      .empty-state {
        margin-top: 1.5rem;
        font-size: 0.95rem;
        color: #475569;
        text-align: center;
      }
      .loading {
        margin: 1rem 0;
        font-size: 0.9rem;
        color: #475569;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p class="notice">Generated ${escapeHtml(generated)} from ${escapeHtml(
        sourceFileName
      )}.</p>
    </header>
    <section class="controls" data-controls>
      <div class="control">
        <span class="control__label">Colors</span>
        <div class="color-filter">
          ${renderColorFilters()}
        </div>
      </div>
      <div class="control">
        <span class="control__label">Card Types</span>
        <label class="checkbox">
          <input type="checkbox" id="lands-toggle" checked />
          Show lands
        </label>
      </div>
      <div class="control">
        <label class="control__label" for="sort-select">Sort</label>
        <select id="sort-select" class="sort-select">
          <option value="mv-asc">Mana Value ↑</option>
          <option value="mv-desc">Mana Value ↓</option>
          <option value="color">Color Identity (WUBRGC)</option>
        </select>
      </div>
      <div class="control">
        <span class="control__label">Show Only</span>
        <label class="checkbox">
          <input type="checkbox" id="filter-recent" />
          Cards printed in 2024+
        </label>
      </div>
      <div class="control">
        <label class="control__label" for="ownership-select">Ownership</label>
        <select id="ownership-select" class="sort-select">
          <option value="all">All cards</option>
          <option value="owned">Owned (checked)</option>
          <option value="unowned">Unowned (unchecked)</option>
        </select>
      </div>
      <div class="control">
        <label class="control__label" for="rarity-select">Rarity</label>
        <select id="rarity-select" class="sort-select">
          <option value="all">All rarities</option>
          <option value="common">Common</option>
          <option value="uncommon">Uncommon</option>
          <option value="rare">Rare</option>
          <option value="mythic">Mythic</option>
        </select>
      </div>
      <div class="control">
        <span class="control__label">Selected Cards</span>
        <button id="copy-selected" class="copy-button" disabled>Copy Selected</button>
      </div>
    </section>
    <p id="loading-state" class="loading">Loading cards…</p>
    <section id="cards-grid" class="grid" aria-live="polite"></section>
    <p id="empty-state" class="empty-state" hidden>No cards match the current filter.</p>
    <script id="card-data" type="application/json">${inlineDataset}</script>
    <script>
      const DATASET_KEY = ${JSON.stringify(safeDatasetKey)};
      const REMOTE_STORE = ${remoteStorePayload};
      const LOCAL_SELECTION_KEY = "card-gallery-selection:" + DATASET_KEY;
      (() => {
        const DATA_URL = ${JSON.stringify(dataUrl)};
        const EARLIEST_YEAR = ${EARLIEST_YEAR};
        const COLOR_ORDER = ["W", "U", "B", "R", "G"];
        const FILTER_CODES = [...COLOR_ORDER, "C", "M"];
        const COLOR_LABELS = {
          W: "White",
          U: "Blue",
          B: "Black",
          R: "Red",
          G: "Green",
          C: "Colorless",
          M: "Multicoloured",
        };

        const grid = document.getElementById("cards-grid");
        const emptyState = document.getElementById("empty-state");
        const loadingState = document.getElementById("loading-state");
        const sortSelect = document.getElementById("sort-select");
        const colorInputs = Array.from(document.querySelectorAll(".color-filter input"));
        const landsToggle = document.getElementById("lands-toggle");
        const copyButton = document.getElementById("copy-selected");
        const recentFilterToggle = document.getElementById("filter-recent");
        const ownershipSelect = document.getElementById("ownership-select");
        const raritySelect = document.getElementById("rarity-select");
        const inlineDataEl = document.getElementById("card-data");
        const inlineData = inlineDataEl ? JSON.parse(inlineDataEl.textContent) : null;

        let allCards = [];
        let activeColors = new Set(FILTER_CODES);
        const selectedNames = new Set();
        let saveTimeout = null;

        Promise.all([loadData(), loadSelectionState()])
          .then(([payload, storedSelection]) => {
            allCards = Array.isArray(payload.cards) ? payload.cards : [];
            (storedSelection || []).forEach((name) => selectedNames.add(name));
            refreshCopyButton();
            renderCardsView();
          })
          .catch((error) => {
            if (loadingState) {
              loadingState.textContent = "Unable to load cards.";
            } else {
              grid.innerHTML = "<p>Unable to load cards.</p>";
            }
            console.error(error);
          });

        colorInputs.forEach((input) => {
          input.addEventListener("change", () => {
            if (input.checked) {
              activeColors.add(input.value);
            } else {
              activeColors.delete(input.value);
            }
            renderCardsView();
          });
        });

        sortSelect.addEventListener("change", () => renderCardsView());
        if (landsToggle) {
          landsToggle.addEventListener("change", () => renderCardsView());
        }
        if (copyButton) {
          copyButton.addEventListener("click", copySelected);
          refreshCopyButton();
        }
        if (recentFilterToggle) {
          recentFilterToggle.addEventListener("change", () => renderCardsView());
        }
        if (ownershipSelect) {
          ownershipSelect.addEventListener("change", () => renderCardsView());
        }
        if (raritySelect) {
          raritySelect.addEventListener("change", () => renderCardsView());
        }

        function matchesColorFilter(card) {
          const colors = cardColors(card);
          if (!colors.length) {
            return activeColors.has("C");
          }
          if (colors.length === 1) {
            const color = colors[0];
            if (color === "C") {
              return activeColors.has("C");
            }
            return activeColors.has(color);
          }
          return activeColors.has("M");
        }

        function matchesLandFilter(card) {
          if (landsToggle && !landsToggle.checked && isLand(card)) {
            return false;
          }
          return true;
        }

        function isLand(card) {
          return typeof card.typeLine === "string" && card.typeLine.toLowerCase().includes("land");
        }

        function sortCards(cards, mode) {
          const arr = [...cards];
          const compareMana = (a, b) => (a.manaValue ?? Infinity) - (b.manaValue ?? Infinity);
          switch (mode) {
            case "mv-desc":
              return arr.sort((a, b) => {
                const result = compareMana(b, a);
                return result === 0 ? a.name.localeCompare(b.name) : result;
              });
            case "color":
              return arr.sort(compareByColor);
            case "mv-asc":
            default:
              return arr.sort((a, b) => {
                const result = compareMana(a, b);
                return result === 0 ? a.name.localeCompare(b.name) : result;
              });
          }
        }

        function cardColors(card) {
          if (Array.isArray(card.colorIdentity) && card.colorIdentity.length) {
            const unique = Array.from(new Set(card.colorIdentity));
            return unique.sort((a, b) => colorIndex(a) - colorIndex(b));
          }
          return ["C"];
        }

        function colorIndex(color) {
          if (color === "C") {
            return COLOR_ORDER.length + 1;
          }
          const idx = COLOR_ORDER.indexOf(color);
          return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
        }

        function compareByColor(a, b) {
          const aKey = colorSortKey(a);
          const bKey = colorSortKey(b);
          if (aKey.group !== bKey.group) {
            return aKey.group - bKey.group;
          }
          if (aKey.detail !== bKey.detail) {
            return aKey.detail.localeCompare(bKey.detail);
          }
          const manaResult = (a.manaValue ?? Infinity) - (b.manaValue ?? Infinity);
          return manaResult === 0 ? a.name.localeCompare(b.name) : manaResult;
        }

        function colorSortKey(card) {
          const colors = cardColors(card);
          if (colors.length === 1) {
            if (colors[0] === "C") {
              return { group: COLOR_ORDER.length + 2, detail: "C" };
            }
            return {
              group: colorIndex(colors[0]),
              detail: colors[0],
            };
          }
          return {
            group: COLOR_ORDER.length + 1,
            detail: colors.join(""),
          };
        }

        function renderCardsView() {
          const filtered = allCards
            .filter((card) => matchesColorFilter(card) && matchesLandFilter(card))
            .filter((card) => matchesRecentFilter(card))
            .filter((card) => matchesOwnershipFilter(card))
            .filter((card) => matchesRarityFilter(card));
          const sorted = sortCards(filtered, sortSelect.value);
          renderCards(sorted);
        }

        function renderCards(cards) {
          if (loadingState) {
            loadingState.hidden = true;
          }
          grid.innerHTML = "";
          if (!cards.length) {
            emptyState.hidden = false;
            return;
          }
          emptyState.hidden = true;
          const fragment = document.createDocumentFragment();
          cards.forEach((card) => fragment.appendChild(createCardElement(card)));
          grid.appendChild(fragment);
          grid.hidden = false;
        }

        function createCardElement(card) {
          const article = document.createElement("article");
          article.className = "card";

          const link = document.createElement("a");
          link.className = "card__image";
          link.href = card.scryfallUri;
          link.target = "_blank";
          link.rel = "noopener";
          const img = document.createElement("img");
          img.loading = "lazy";
          img.alt = \`\${card.name} card art\`;
          img.src = card.imagePath || card.remoteImageUri || "";
          link.appendChild(img);
          article.appendChild(link);

          const body = document.createElement("div");
          body.className = "card__body";
          article.appendChild(body);

          const nameRow = document.createElement("div");
          nameRow.className = "card__name-row";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "card__select";
          checkbox.checked = selectedNames.has(card.name);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              selectedNames.add(card.name);
            } else {
              selectedNames.delete(card.name);
            }
            refreshCopyButton();
            scheduleSaveSelection();
            renderCardsView();
          });
          nameRow.appendChild(checkbox);
          const name = document.createElement("h2");
          name.className = "card__name";
          name.textContent = card.name;
          nameRow.appendChild(name);
          if (card.isNew) {
            const badge = document.createElement("span");
            badge.className = "card__badge";
            badge.textContent = "NEW";
            nameRow.appendChild(badge);
          }
          body.appendChild(nameRow);

          const manaLine = document.createElement("p");
          manaLine.className = "card__mana-line";
          if (card.manaCost) {
            const manaSpan = document.createElement("span");
            manaSpan.className = "card__mana";
            manaSpan.textContent = card.manaCost;
            manaLine.appendChild(manaSpan);
          }
          if (Number.isFinite(card.manaValue) && card.manaValue !== Infinity) {
            const mvSpan = document.createElement("span");
            mvSpan.className = "card__mv";
            mvSpan.textContent = formatManaValue(card.manaValue);
            manaLine.appendChild(mvSpan);
          }
          if (manaLine.children.length) {
            body.appendChild(manaLine);
          }

          const cube = document.createElement("p");
          cube.className = "card__meta";
          cube.innerHTML = \`Cube Count: <strong>\${card.cubeCount}</strong>\`;
          body.appendChild(cube);

          if (card.colorIdentity) {
            const colors = document.createElement("p");
            colors.className = "card__meta";
            colors.textContent = colorIdentityLabel(card);
            body.appendChild(colors);
          }

          if (card.typeLine) {
            const type = document.createElement("p");
            type.className = "card__typeline";
            type.textContent = card.typeLine;
            body.appendChild(type);
          }

          const setsWrapper = document.createElement("div");
          setsWrapper.className = "card__sets";
          const setsTitle = document.createElement("h3");
          setsTitle.className = "card__sets-title";
          setsTitle.textContent = "Set Printings";
          setsWrapper.appendChild(setsTitle);
          const list = document.createElement("ul");
          list.className = "sets-list";
          appendSetItems(list, card.setPrintings || []);
          setsWrapper.appendChild(list);
          body.appendChild(setsWrapper);

          return article;
        }

        function appendSetItems(listEl, sets) {
          if (!sets.length) {
            const li = document.createElement("li");
            li.className = "set-item set-item--empty";
            const span = document.createElement("span");
            span.className = "set-item__text";
            span.textContent = \`No sets from \${EARLIEST_YEAR} onward\`;
            li.appendChild(span);
            listEl.appendChild(li);
            return;
          }
          sets.forEach((set) => {
            const li = document.createElement("li");
            li.className = "set-item";

            const icon = document.createElement("span");
            icon.className = "set-item__icon";
            if (set.iconPath) {
              const img = document.createElement("img");
              img.src = set.iconPath;
              img.alt = \`\${set.setCode} symbol\`;
              img.loading = "lazy";
              icon.appendChild(img);
            }
            li.appendChild(icon);

            const text = document.createElement("span");
            text.className = "set-item__text";
            const title = document.createElement("span");
            title.textContent = \`\${set.setName} (\${set.setCode})\`;
            text.appendChild(title);

            const rarities = document.createElement("span");
            rarities.className = "set-item__rarities";
            if (Array.isArray(set.rarities) && set.rarities.length) {
              set.rarities.forEach((rarity) => {
                const badge = document.createElement("span");
                badge.className = \`set-item__rarity \${rarityClassName(rarity)}\`;
                badge.textContent = capitalize(rarity);
                rarities.appendChild(badge);
              });
            } else {
              const badge = document.createElement("span");
              badge.className = "set-item__rarity rarity--unknown";
              badge.textContent = "Unknown rarity";
              rarities.appendChild(badge);
            }
            text.appendChild(rarities);
            li.appendChild(text);

            listEl.appendChild(li);
          });
        }

        function rarityClassName(rarity) {
          const key = String(rarity || "").toLowerCase();
          return ["common", "uncommon", "rare", "mythic"].includes(key)
            ? \`rarity--\${key}\`
            : "rarity--unknown";
        }

        function capitalize(value) {
          return String(value).charAt(0).toUpperCase() + String(value).slice(1);
        }

        function formatManaValue(value) {
          if (!Number.isFinite(value) || value === Infinity) {
            return "";
          }
          return Number.isInteger(value) ? \`MV \${value}\` : \`MV \${value.toFixed(2).replace(/\\.0+$/, "")}\`;
        }

        function colorIdentityLabel(card) {
          const colors = cardColors(card);
          return colors.map((code) => COLOR_LABELS[code] ?? code).join(", ");
        }

        function refreshCopyButton() {
          if (!copyButton) return;
          const count = selectedNames.size;
          copyButton.textContent = count ? "Copy Selected (" + count + ")" : "Copy Selected";
          copyButton.disabled = count === 0;
        }

        function scheduleSaveSelection() {
          if (saveTimeout) {
            clearTimeout(saveTimeout);
          }
          saveTimeout = setTimeout(() => {
            persistSelectionState().catch((error) => console.warn("Failed to persist selections", error));
          }, 400);
        }

        async function loadSelectionState() {
          if (REMOTE_STORE) {
            const remoteData = await loadRemoteSelection();
            if (remoteData && remoteData.length) {
              saveLocalSelection(remoteData);
              return remoteData;
            }
          }
          return loadLocalSelection();
        }

        function loadLocalSelection() {
          try {
            const raw = localStorage.getItem(LOCAL_SELECTION_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
          } catch (error) {
            console.warn("Failed to read local selections", error);
            return [];
          }
        }

        function saveLocalSelection(list) {
          try {
            localStorage.setItem(LOCAL_SELECTION_KEY, JSON.stringify(list));
          } catch (error) {
            console.warn("Failed to save selections locally", error);
          }
        }

        async function loadRemoteSelection() {
          if (!REMOTE_STORE) return [];
          const endpoint = REMOTE_STORE.endpoint;
          if (!endpoint) return [];
          try {
            const resp = await fetch(endpoint + "?profile_id=" + encodeURIComponent(REMOTE_STORE.profile), {
              headers: remoteHeaders(),
              method: "GET",
            });
            if (!resp.ok) {
              throw new Error("HTTP " + resp.status);
            }
            const data = await resp.json();
            return Array.isArray(data) ? data.map((row) => row.card_name).filter(Boolean) : [];
          } catch (error) {
            console.warn("Remote selection fetch failed", error);
            return [];
          }
        }

        async function saveRemoteSelection(list) {
          if (!REMOTE_STORE) return;
          const endpoint = REMOTE_STORE.endpoint;
          if (!endpoint) return;
          try {
            const payload = list.map((name) => ({
              profile_id: REMOTE_STORE.profile,
              card_name: name,
            }));
            const resp = await fetch(endpoint + "?profile_id=" + encodeURIComponent(REMOTE_STORE.profile), {
              method: "POST",
              headers: { ...remoteHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            if (!resp.ok) {
              throw new Error("HTTP " + resp.status);
            }
          } catch (error) {
            console.warn("Remote selection save failed", error);
          }
        }

        async function persistSelectionState() {
          const list = Array.from(selectedNames);
          saveLocalSelection(list);
          if (REMOTE_STORE) {
            await saveRemoteSelection(list);
          }
        }

        async function copySelected() {
          if (!copyButton || !selectedNames.size) {
            return;
          }
          const text = Array.from(selectedNames).join("\\n");
          try {
            await navigator.clipboard.writeText(text);
            flashCopyState("Copied!");
          } catch (error) {
            fallbackCopy(text);
          }
        }

        function matchesRecentFilter(card) {
          if (!recentFilterToggle?.checked) {
            return true;
          }
          return cardHasRecentSet(card);
        }

        function matchesOwnershipFilter(card) {
          if (!ownershipSelect) return true;
          const mode = ownershipSelect.value;
          const isChecked = selectedNames.has(card.name);
          if (mode === "owned") {
            return isChecked;
          }
          if (mode === "unowned") {
            return !isChecked;
          }
          return true;
        }

        function matchesRarityFilter(card) {
          if (!raritySelect || raritySelect.value === "all") {
            return true;
          }
          const desired = raritySelect.value;
          if (!Array.isArray(card.setPrintings) || !card.setPrintings.length) {
            return false;
          }
          return card.setPrintings.some((set) =>
            Array.isArray(set.rarities) && set.rarities.some((rarity) => rarity === desired)
          );
        }

        function cardHasRecentSet(card) {
          return Array.isArray(card.setPrintings) && card.setPrintings.some((set) => isRecentSet(set));
        }

        function isRecentSet(set) {
          if (!set || !set.releasedAt) return false;
          const year = new Date(set.releasedAt).getFullYear();
          return Number.isFinite(year) && year >= 2024;
        }

        function latestRecentSet(card) {
          if (!Array.isArray(card.setPrintings)) return null;
          const recentSets = card.setPrintings.filter((set) => isRecentSet(set));
          if (!recentSets.length) return null;
          return recentSets.sort((a, b) => new Date(b.releasedAt || 0) - new Date(a.releasedAt || 0))[0];
        }

        function fallbackCopy(text) {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "absolute";
          textarea.style.left = "-9999px";
          document.body.appendChild(textarea);
          textarea.select();
          try {
            document.execCommand("copy");
            flashCopyState("Copied!");
          } catch (error) {
            flashCopyState("Copy failed");
          } finally {
            document.body.removeChild(textarea);
          }
        }

        function flashCopyState(message) {
          if (!copyButton) return;
          copyButton.textContent = message;
          copyButton.disabled = true;
          setTimeout(() => {
            refreshCopyButton();
          }, 1200);
        }

        function remoteHeaders() {
          if (!REMOTE_STORE) return {};
          return {
            apikey: REMOTE_STORE.anonKey,
            Authorization: "Bearer " + REMOTE_STORE.serviceRole,
          };
        }
        function loadData() {
          if (location.protocol === "file:" && inlineData) {
            return Promise.resolve(inlineData);
          }
          return fetch(DATA_URL)
            .then((resp) => {
              if (!resp.ok) {
                throw new Error("Failed to load card data");
              }
              return resp.json();
            })
            .catch((error) => {
              if (inlineData) {
                console.warn("Falling back to inline data:", error);
                return inlineData;
              }
              throw error;
            });
        }
      })();
    </script>
  </body>
</html>`;
}

function renderColorFilters() {
  const options = [
    ["W", "White"],
    ["U", "Blue"],
    ["B", "Black"],
    ["R", "Red"],
    ["G", "Green"],
    ["C", "Colorless"],
    ["M", "Multicoloured"],
  ];
  return options
    .map(
      ([value, label]) => `
        <label>
          <input type="checkbox" value="${value}" checked />
          ${label}
        </label>`
    )
    .join("");
}

/**
 * Basic pause helper (await pause(ms)).
 * @param {number} duration
 */
function pause(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function reportProgress(current, total) {
  if (!total) return;
  const percent = Math.floor((current / total) * 100);
  const barLength = 20;
  const filledLength = Math.round((barLength * current) / total);
  const bar = "#".repeat(filledLength) + "-".repeat(barLength - filledLength);
  process.stdout.write(`\r[${bar}] ${current}/${total} (${percent}%)`);
}

/**
 * Escapes HTML entities.
 * @param {string} value
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "card";
}

function capitalize(text) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function inlineJson(jsonString) {
  return String(jsonString)
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function canonicalizeBaseName(name) {
  if (!name) {
    return "cards";
  }
  const normalized = String(name).trim();
  const match = normalized.match(/^(.*?)(-\d+)?$/);
  if (match && match[2]) {
    return match[1] || normalized;
  }
  return normalized;
}

function parseCliArguments(argv) {
  const result = {
    renderOnly: false,
    positional: [],
  };

  for (const arg of argv) {
    if (arg === "--render-only") {
      result.renderOnly = true;
    } else {
      result.positional.push(arg);
    }
  }

  return {
    input: result.positional[0] ?? null,
    outputOverride: result.positional[1] ?? null,
    renderOnly: result.renderOnly,
  };
}

function buildRemoteStoreConfig() {
  const baseUrl = process.env.REMOTE_STORE_URL;
  const anonKey = process.env.REMOTE_STORE_KEY;
  const serviceRole = process.env.REMOTE_STORE_SERVICE_ROLE || anonKey;
  const table = process.env.REMOTE_STORE_TABLE || "card_selections";
  const profile = process.env.REMOTE_STORE_PROFILE || null;
  if (!baseUrl || !anonKey || !profile) {
    return null;
  }
  return {
    baseUrl,
    endpoint: baseUrl,
    anonKey,
    serviceRole,
    table,
    profile,
  };
}
