/**
 * Marketplaces without a supported interface: link-only entries (their website, since no search
 * template was verified). Requests for them finish as unsupported.
 */
export const LINK_ONLY_MARKETPLACES: Record<string, { name: string; website: string; reason: string }> = {
  sedo: {
    name: 'Sedo',
    website: 'https://sedo.com/',
    reason: 'Sedo documents a keyless keyword feed without prices and a partner API that needs a partner id and sign key; neither is integrated.',
  },
  afternic: {
    name: 'Afternic',
    website: 'https://www.afternic.com/',
    reason: 'Afternic documents only an authenticated seller portfolio API, not anonymous marketplace search.',
  },
  dan: {
    name: 'Dan.com',
    website: 'https://dan.com/',
    reason: 'Dan.com listings moved to Afternic and GoDaddy; no listing API is documented.',
  },
  atom: {
    name: 'Atom',
    website: 'https://www.atom.com/',
    reason: 'Atom documents an anonymous MCP search of its curated inventory with an unconfirmed result schema; it is not integrated.',
  },
};
