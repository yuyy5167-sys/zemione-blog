import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_DEPLOY_COMMAND = 'npm run deploy:workers-build';
const REQUIRED_FILES = [
	'src/worker.ts',
	'src/components/Header.astro',
	'src/components/ArticleCard.astro',
	'src/styles/global.css',
	'src/config/site.ts',
	'src/pages/__build.json.ts',
	'src/pages/search/index.astro',
];

export function validateWorkersBuildEnvironment(env) {
	const issues = [];
	if (env.WORKERS_CI !== '1') issues.push('WORKERS_CI must be 1.');
	if (env.ZEMIONE_WORKERS_DEPLOY_COMMAND !== REQUIRED_DEPLOY_COMMAND) {
		issues.push(`ZEMIONE_WORKERS_DEPLOY_COMMAND must equal "${REQUIRED_DEPLOY_COMMAND}".`);
	}
	if (!/^[0-9a-f]{40}$/i.test(env.WORKERS_CI_COMMIT_SHA ?? '')) {
		issues.push('WORKERS_CI_COMMIT_SHA must be a 40-character Git commit SHA.');
	}
	return issues;
}

export function validateWranglerConfig(config) {
	const issues = [];
	if (config.name !== 'zemione') issues.push('wrangler.jsonc name must be zemione.');
	if (config.main !== './src/worker.ts') issues.push('wrangler.jsonc must use ./src/worker.ts as main.');
	if (config.workers_dev !== false) issues.push('wrangler.jsonc workers_dev must be false.');
	if (config.assets?.directory !== './dist') issues.push('assets.directory must be ./dist.');
	if (config.assets?.binding !== 'ASSETS') issues.push('assets.binding must be ASSETS.');
	if (!Array.isArray(config.assets?.run_worker_first) || !config.assets.run_worker_first.includes('/api/article-event')) {
		issues.push('assets.run_worker_first must include /api/article-event.');
	}
	if (config.assets?.not_found_handling !== '404-page') issues.push('assets.not_found_handling must be 404-page.');
	const analytics = Array.isArray(config.analytics_engine_datasets) ? config.analytics_engine_datasets : [];
	if (!analytics.some((entry) => entry?.binding === 'ARTICLE_EVENTS' && entry?.dataset === 'article_events')) {
		issues.push('ARTICLE_EVENTS analytics binding is missing.');
	}
	return issues;
}

export function validateRenderedHtml(html) {
	const issues = [];
	if (!/class=["'][^"']*\bsite-header\b/i.test(html)) issues.push('site-header is missing from rendered HTML.');
	if (!/class=["'][^"']*\barticle-card\b/i.test(html)) issues.push('article-card is missing from rendered HTML.');
	if (!/<link\b[^>]*rel=["']stylesheet["'][^>]*>/i.test(html)) issues.push('stylesheet link is missing from rendered HTML.');
	return issues;
}

async function fileExists(path) {
	try {
		await access(path, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}

async function readRequiredFile(root, relativePath, issues) {
	const fullPath = resolve(root, relativePath);
	if (!(await fileExists(fullPath))) {
		issues.push(`Required production file is missing: ${relativePath}`);
		return '';
	}
	return readFile(fullPath, 'utf8');
}

export async function validateProject(root) {
	const issues = [];
	const wranglerText = await readRequiredFile(root, 'wrangler.jsonc', issues);
	if (wranglerText) {
		try {
			issues.push(...validateWranglerConfig(JSON.parse(wranglerText)));
		} catch (error) {
			issues.push(`wrangler.jsonc must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	for (const relativePath of REQUIRED_FILES) await readRequiredFile(root, relativePath, issues);

	const worker = await readRequiredFile(root, 'src/worker.ts', issues);
	if (worker && (!worker.includes('ASSETS') || !worker.includes('ARTICLE_EVENTS'))) {
		issues.push('src/worker.ts must reference both ASSETS and ARTICLE_EVENTS.');
	}
	const header = await readRequiredFile(root, 'src/components/Header.astro', issues);
	if (header && !header.includes('site-header')) issues.push('Header.astro must contain the site-header contract.');
	const articleCard = await readRequiredFile(root, 'src/components/ArticleCard.astro', issues);
	if (articleCard && !articleCard.includes('article-card')) issues.push('ArticleCard.astro must contain the article-card contract.');
	const layout = await readRequiredFile(root, 'src/layouts/Base.astro', issues);
	if (layout && (!layout.includes('Header') || !layout.includes('globalStylesheet'))) {
		issues.push('Base.astro must render Header and the global stylesheet.');
	}
	const home = await readRequiredFile(root, 'src/pages/index.astro', issues);
	if (home && !home.includes('ArticleCard')) issues.push('index.astro must render ArticleCard.');
	const astroConfig = await readRequiredFile(root, 'astro.config.mjs', issues);
	if (astroConfig && !astroConfig.includes('internalLinkCards')) issues.push('astro.config.mjs must enable internalLinkCards.');

	return [...new Set(issues)];
}

function gitHead(root) {
	const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`Unable to read Git HEAD: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

function fail(heading, issues) {
	throw new Error(`${heading}\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
}

async function gate(root, env, strict) {
	const workersBuild = env.WORKERS_CI === '1';
	if (!workersBuild && !strict) {
		console.log('Deployment safety gate: local build; Workers production gate is not active.');
		return;
	}

	const issues = await validateProject(root);
	if (workersBuild) {
		issues.unshift(...validateWorkersBuildEnvironment(env));
		const head = gitHead(root);
		if (env.WORKERS_CI_COMMIT_SHA && head.toLowerCase() !== env.WORKERS_CI_COMMIT_SHA.toLowerCase()) {
			issues.push(`Checked-out HEAD does not match WORKERS_CI_COMMIT_SHA (${head}).`);
		}
	}
	if (issues.length) fail('Deployment safety gate blocked this build.', issues);
	console.log(`Deployment safety gate passed${workersBuild ? ` for ${env.WORKERS_CI_COMMIT_SHA}` : ''}.`);
}

async function validateDist(root, expectedSha) {
	const issues = [];
	const html = await readRequiredFile(root, 'dist/index.html', issues);
	if (html) issues.push(...validateRenderedHtml(html));
	const metadataText = await readRequiredFile(root, 'dist/__build.json', issues);
	if (metadataText) {
		try {
			const metadata = JSON.parse(metadataText);
			if (metadata.commitSha !== expectedSha) issues.push(`dist/__build.json commitSha must be ${expectedSha}.`);
		} catch (error) {
			issues.push(`dist/__build.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (issues.length) fail('Built output is not safe to upload.', issues);
}

function runNpx(root, args) {
	const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
	const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Command failed with exit code ${result.status}: npx ${args.join(' ')}`);
}

async function upload(root, env) {
	await gate(root, env, true);
	const sha = env.WORKERS_CI_COMMIT_SHA;
	await validateDist(root, sha);
	const message = `Workers Builds preview ${sha.slice(0, 12)}`;
	runNpx(root, ['wrangler', 'versions', 'upload', '--name', 'zemione', '--message', message]);
}

function argumentValues(args, name) {
	const values = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
	}
	return values;
}

function firstArgument(args, name) {
	return argumentValues(args, name)[0];
}

async function fetchText(url) {
	const response = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, redirect: 'follow' });
	if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
	return { response, text: await response.text() };
}

async function verify(args) {
	const baseInput = firstArgument(args, '--url');
	const expectedSha = firstArgument(args, '--expect-sha');
	if (!baseInput || !expectedSha) throw new Error('verify requires --url <https-url> and --expect-sha <40-character-sha>.');
	if (!/^[0-9a-f]{40}$/i.test(expectedSha)) throw new Error('--expect-sha must be a 40-character Git commit SHA.');
	const base = new URL(baseInput);
	if (base.protocol !== 'https:') throw new Error('--url must use HTTPS.');

	const metadataUrl = new URL(`/__build.json?verify=${Date.now()}`, base);
	const metadata = JSON.parse((await fetchText(metadataUrl)).text);
	if (metadata.commitSha !== expectedSha) throw new Error(`Live commit mismatch: expected ${expectedSha}, got ${metadata.commitSha}.`);

	const paths = ['/', ...argumentValues(args, '--path')];
	const checkedStylesheets = new Set();
	for (const path of paths) {
		const pageUrl = new URL(path, base);
		pageUrl.searchParams.set('verify', String(Date.now()));
		const { text: html } = await fetchText(pageUrl);
		const htmlIssues = path === '/' ? validateRenderedHtml(html) : [];
		if (!/<h1\b/i.test(html)) htmlIssues.push(`H1 is missing from ${path}.`);
		if (htmlIssues.length) fail(`Release verification failed for ${path}.`, htmlIssues);

		for (const match of html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi)) {
			const stylesheetUrl = new URL(match[1], pageUrl).href;
			if (checkedStylesheets.has(stylesheetUrl)) continue;
			checkedStylesheets.add(stylesheetUrl);
			const { response } = await fetchText(stylesheetUrl);
			if (!(response.headers.get('content-type') ?? '').includes('text/css')) throw new Error(`${stylesheetUrl} is not served as CSS.`);
		}
	}
	console.log(JSON.stringify({ verifiedUrl: base.origin, commitSha: expectedSha, paths, stylesheets: checkedStylesheets.size }, null, 2));
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	const root = resolve(firstArgument(args, '--root') ?? process.cwd());
	if (command === 'gate') return gate(root, process.env, args.includes('--strict'));
	if (command === 'upload') return upload(root, process.env);
	if (command === 'verify') return verify(args);
	throw new Error('Usage: deployment-safety.mjs <gate|upload|verify> [options]');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
