const patternRegex = pattern => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);

/** Expand saved glob references against discovered Skills; never enables undiscovered names. */
export function selectedSkillNames(skills, patterns = []) {
	const matchers = patterns.map(patternRegex);
	return new Set(skills.filter(skill => matchers.some(regex => regex.test(skill.name))).map(skill => skill.name));
}

/** Intersect search terms, category and draft selection status; absent selection is browse-only. */
export function filterSkills(skills, { query = "", category = "全部", status = "all", selected = null } = {}) {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return skills.filter(skill => (category === "全部" || skill.category === category)
		&& terms.every(term => `${skill.name} ${skill.description ?? ""} ${skill.category ?? ""}`.toLowerCase().includes(term))
		&& (!selected || status === "all" || selected.has(skill.name) === (status === "on")));
}

/** Change only discovered names in the current result snapshot, preserving unrelated/missing refs.
 * Partial changes materialize matched globs so deselection works; no-op retains original patterns.
 */
export function updateSkillSelection(skills, patterns, resultNames, enabled) {
	const selected = selectedSkillNames(skills, patterns);
	const known = new Set(skills.map(skill => skill.name));
	const names = resultNames.filter(name => known.has(name));
	if (names.every(name => selected.has(name) === enabled)) return [...patterns];
	for (const pattern of patterns) if (!skills.some(skill => patternRegex(pattern).test(skill.name))) selected.add(pattern);
	for (const name of names) enabled ? selected.add(name) : selected.delete(name);
	return [...selected].sort();
}
