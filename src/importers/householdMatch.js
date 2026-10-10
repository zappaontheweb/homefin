// Shared helper for bank importers: figures out which household member(s) own an
// account from the holder text printed in the export (e.g. "Intestatari", "Intestazione").

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function memberTerms(member) {
  return [member?.name, ...(member?.keywords || [])].map(normalizeText).filter((t) => t.length >= 2);
}

export function matchMembers(text, members = []) {
  const haystack = ` ${normalizeText(text)} `;
  return members.filter((m) => memberTerms(m).some((term) => haystack.includes(` ${term} `)));
}

// Words that identify money moving between the household's own accounts.
export function ownAccountTerms(members = []) {
  return members.flatMap(memberTerms);
}

/**
 * @param {string} holderText raw holder text from the export
 * @param {{ members?: {id:string,name:string,keywords?:string[]}[], sharedLabel?: string }} options
 * @param {string} bankLabel e.g. "MP", "Fineco"
 */
export function inferAccountOwnership(holderText, options = {}, bankLabel = "Bank") {
  const members = options.members || [];
  const sharedLabel = options.sharedLabel || "Shared";
  const raw = String(holderText || "").trim();
  const matched = matchMembers(raw, members);
  if (matched.length > 1) {
    return { accountName: `${bankLabel} shared`, accountScope: "shared", holder: sharedLabel, personalFlag: "comune", split: "household", accountHolders: raw };
  }
  // No match falls back to the first member; fix it later from the Data tab or add owner keywords.
  const owner = matched[0] || members[0];
  if (!owner) return { accountName: bankLabel, accountScope: "", holder: raw, personalFlag: "personale", accountHolders: raw };
  return { accountName: `${bankLabel} ${owner.name}`, accountScope: owner.id, holder: owner.name, personalFlag: "personale", accountHolders: raw };
}
