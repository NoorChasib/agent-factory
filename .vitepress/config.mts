import { defineConfig } from "vitepress";

export default defineConfig({
	title: "Agent Factory",
	description: "Standalone controller that supervises coding-agent workers against GitHub work.",

	// Serve the repository's existing markdown in place: the repo root is the source directory, so
	// the root README becomes the home page and every existing relative cross-link keeps working.
	srcDir: ".",
	srcExclude: ["AGENTS.md", "CLAUDE.md"],
	rewrites: {
		"README.md": "index.md",
		":dir/README.md": ":dir/index.md",
	},

	// These links target non-markdown assets — the systemd unit file and the protocol fixture
	// directory — that VitePress does not emit as routes. They, along with the example-profile
	// `.yaml` links on the profiles and config pages, 404 on the built site by design: the docs'
	// relative links are written for GitHub browsing.
	ignoreDeadLinks: [/agent-factory\.service$/, /worker-result\/v1\/index$/],

	markdown: {
		config(md) {
			const normalizeLink = md.normalizeLink.bind(md);
			md.normalizeLink = (url) => normalizeLink(url.replace(/README\.md(#|$)/, "index.md$1"));
		},
	},

	themeConfig: {
		search: { provider: "local" },
		outline: [2, 3],
		nav: [
			{ text: "Overview", link: "/" },
			{ text: "Docs index", link: "/docs/" },
			{ text: "CLI", link: "/docs/cli" },
		],
		sidebar: [
			{
				text: "Getting started",
				items: [
					{ text: "Operator overview", link: "/" },
					{ text: "Documentation index", link: "/docs/" },
					{ text: "Installation", link: "/docs/installation" },
					{ text: "GitHub App setup", link: "/docs/github-app" },
				],
			},
			{
				text: "Concepts",
				items: [
					{ text: "Architecture", link: "/docs/architecture" },
					{ text: "Profiles and protocol fixtures", link: "/docs/profiles" },
					{ text: "Configuration examples", link: "/config/" },
					{ text: "GitHub integration", link: "/docs/github" },
					{ text: "Label migration", link: "/docs/label-migration" },
					{ text: "Ledger", link: "/docs/ledger" },
					{ text: "Providers", link: "/docs/providers" },
					{ text: "Convergence", link: "/docs/convergence" },
					{ text: "Conflict repair", link: "/docs/conflict-repair" },
					{ text: "Herdr", link: "/docs/herdr" },
					{ text: "Recovery", link: "/docs/recovery" },
				],
			},
			{
				text: "Running the factory",
				items: [
					{ text: "Operations", link: "/docs/operations" },
					{ text: "systemd unit", link: "/systemd/" },
					{ text: "CLI reference", link: "/docs/cli" },
					{ text: "Immutable releases", link: "/docs/updates" },
					{ text: "Security", link: "/docs/security" },
					{ text: "Troubleshooting", link: "/docs/troubleshooting" },
				],
			},
			{
				text: "Development",
				items: [
					{ text: "Testing", link: "/docs/testing" },
					{ text: "Post-v1", link: "/docs/post-v1" },
				],
			},
		],
		socialLinks: [{ icon: "github", link: "https://github.com/NoorChasib/agent-factory" }],
	},
});
