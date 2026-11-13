/**
 * Glyphi Teams' identity in one place: the updater reads releases from this
 * repository, and the app sends people here for documentation and bug reports.
 *
 * It is a different repository from Glyphi's on purpose: the two apps install
 * side by side, update on their own schedule and never share a data folder.
 */
export const REPOSITORY = "Artleboss2/Glyphi-Teams";
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
