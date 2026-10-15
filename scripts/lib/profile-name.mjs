/** Profile IDs are filenames and launch identifiers; schema/default names are reserved. */
export function isProfileName(name) {
	return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
		&& !["default", "profile.schema"].includes(name.toLowerCase());
}
