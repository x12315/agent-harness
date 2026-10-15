import assert from "node:assert/strict";
import test from "node:test";
import { selectedSkillNames, filterSkills, updateSkillSelection } from "../../web/skill-selection.js";

const skills = [
	{ name: "lark-doc", description: "Read and edit documents", category: "飞书" },
	{ name: "lark-base", description: "Manage records", category: "飞书" },
	{ name: "lark-wiki", description: "Browse wiki pages", category: "飞书" },
	{ name: "agent-browser", description: "Browser automation", category: "检索" },
	{ name: "git-commit", description: "Commit changes", category: "Git" },
];

const names = results => results.map(skill => skill.name);

test("Saved Skill globs expand only discovered names with anchored * and ? matching", () => {
	assert.deepEqual(selectedSkillNames(skills), new Set());
	assert.deepEqual(selectedSkillNames(skills, ["lark-*", "lark-doc", "missing-skill"]), new Set(["lark-doc", "lark-base", "lark-wiki"]));
	assert.deepEqual(selectedSkillNames(skills, ["lark-???"]), new Set(["lark-doc"]));
	assert.deepEqual(selectedSkillNames(skills, ["lark-?a*"]), new Set(["lark-base"]));
	assert.deepEqual(selectedSkillNames(skills, ["lark-doc*"]), new Set(["lark-doc"]));
	assert.deepEqual(selectedSkillNames(skills, ["doc", "lark-??", "missing-*"]), new Set());
	assert.deepEqual(selectedSkillNames(skills, ["*"]), new Set(names(skills)));
});

test("Skill glob expansion escapes regular expression metacharacters", () => {
	const literalNames = ["skill.a", "skill+a", "skill^a", "skill$a", "skill{a}", "skill(a)", "skill|a", "skill[a]", "skill\\a"];
	const discovered = [...literalNames, "skillXa", "skilla", "skill", "a"].map(name => ({ name }));
	for (const name of literalNames) assert.deepEqual(selectedSkillNames(discovered, [name]), new Set([name]), name);
	assert.deepEqual(selectedSkillNames(discovered, ["skill.?"]), new Set(["skill.a"]));
	assert.deepEqual(selectedSkillNames(discovered, ["skill[a]*"]), new Set(["skill[a]"]));
});

test("Skill search matches names, descriptions and Chinese categories with case-insensitive AND terms", () => {
	assert.deepEqual(names(filterSkills(skills, { query: "LARK-DOC" })), ["lark-doc"]);
	assert.deepEqual(names(filterSkills(skills, { query: "AUTOMATION" })), ["agent-browser"]);
	assert.deepEqual(names(filterSkills(skills, { query: "飞书" })), ["lark-doc", "lark-base", "lark-wiki"]);
	assert.deepEqual(names(filterSkills(skills, { query: "  LaRk\tDOCUMENTS\n飞书  " })), ["lark-doc"]);
	assert.deepEqual(filterSkills(skills, { query: "documents records" }), []);
	assert.deepEqual(filterSkills(skills, { query: " \t\n " }), skills);
	assert.deepEqual(filterSkills([{ name: "bare" }], { query: "BARE" }), [{ name: "bare" }]);
});

test("Skill filtering intersects query, category and enabled or disabled draft status", () => {
	const selected = selectedSkillNames(skills, ["lark-doc", "agent-browser"]);
	assert.deepEqual(names(filterSkills(skills, { query: "LARK", category: "飞书", status: "on", selected })), ["lark-doc"]);
	assert.deepEqual(names(filterSkills(skills, { query: "LARK", category: "飞书", status: "off", selected })), ["lark-base", "lark-wiki"]);
	assert.deepEqual(names(filterSkills(skills, { category: "飞书", status: "all", selected })), ["lark-doc", "lark-base", "lark-wiki"]);
	assert.deepEqual(filterSkills(skills, { query: "automation", category: "飞书", status: "on", selected }), []);
	assert.deepEqual(filterSkills(skills, { status: "on", selected: new Set() }), []);
	assert.deepEqual(filterSkills(skills, { status: "off", selected: new Set() }), skills);
});

test("Browse-only Skill filtering ignores selection status but still applies search and category", () => {
	for (const status of ["on", "off"]) {
		assert.deepEqual(filterSkills(skills, { status }), skills);
		assert.deepEqual(names(filterSkills(skills, { query: "wiki", category: "飞书", status, selected: null })), ["lark-wiki"]);
	}
});

test("Scoped bulk changes preserve hidden selections and unmatched saved references without mutating inputs", () => {
	const originalSkills = structuredClone(skills);
	const patterns = ["lark-w*", "git-commit", "missing-skill", "future-*"];
	const resultNames = names(filterSkills(skills, { category: "飞书", query: "documents" }));
	const enabled = updateSkillSelection(skills, patterns, resultNames, true);
	assert.deepEqual(enabled, ["future-*", "git-commit", "lark-doc", "lark-wiki", "missing-skill"]);
	assert.deepEqual(updateSkillSelection(skills, enabled, resultNames, false), ["future-*", "git-commit", "lark-wiki", "missing-skill"]);
	assert.deepEqual(patterns, ["lark-w*", "git-commit", "missing-skill", "future-*"]);
	assert.deepEqual(resultNames, ["lark-doc"]);
	assert.deepEqual(skills, originalSkills);
});

test("No-op and empty bulk changes retain original wildcard references and their order", () => {
	for (const patterns of [["lark-*", "missing-skill", "future-*"], ["*", "missing-skill"]]) {
		for (const [resultNames, enabled] of [[["lark-doc"], true], [[], true], [[], false]]) {
			assert.deepEqual(updateSkillSelection(skills, patterns, resultNames, enabled), patterns);
		}
	}
	const patterns = ["lark-*", "future-*"];
	assert.deepEqual(updateSkillSelection(skills, patterns, ["agent-browser"], false), patterns);
});

test("Partial deselection of * materializes remaining discovered Skills including hidden selections", () => {
	const patterns = ["*", "missing-*"];
	const visible = names(filterSkills(skills, { query: "documents", category: "飞书" }));
	assert.deepEqual(updateSkillSelection(skills, patterns, visible, false), ["agent-browser", "git-commit", "lark-base", "lark-wiki", "missing-*"]);
	assert.deepEqual(patterns, ["*", "missing-*"]);
});

test("Unknown bulk target names are ignored even when they are unmatched saved references", () => {
	const patterns = ["git-commit", "missing-skill", "future-*"];
	for (const enabled of [true, false]) {
		assert.deepEqual(updateSkillSelection(skills, patterns, ["unknown", "missing-skill"], enabled), patterns);
	}
	assert.deepEqual(updateSkillSelection(skills, patterns, ["agent-browser", "unknown"], true), ["agent-browser", "future-*", "git-commit", "missing-skill"]);
	assert.deepEqual(updateSkillSelection(skills, ["*"], ["lark-doc", "unknown"], false), ["agent-browser", "git-commit", "lark-base", "lark-wiki"]);
});
