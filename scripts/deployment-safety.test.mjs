import test from 'node:test';
import assert from 'node:assert/strict';
import {
	validateRenderedHtml,
	validateWorkersBuildEnvironment,
	validateWranglerConfig,
} from './deployment-safety.mjs';

const validWrangler = {
	name: 'zemione',
	main: './src/worker.ts',
	compatibility_date: '2026-08-01',
	workers_dev: false,
	assets: {
		directory: './dist',
		binding: 'ASSETS',
		run_worker_first: ['/api/article-event'],
		not_found_handling: '404-page',
	},
	analytics_engine_datasets: [{ binding: 'ARTICLE_EVENTS', dataset: 'article_events' }],
};

test('the full Worker contract is accepted', () => {
	assert.deepEqual(validateWranglerConfig(validWrangler), []);
});

test('the former static-only configuration is rejected', () => {
	const issues = validateWranglerConfig({
		name: 'zemione',
		compatibility_date: '2026-08-01',
		assets: { directory: './dist', not_found_handling: '404-page' },
	});
	assert.ok(issues.some((issue) => issue.includes('src/worker.ts')));
	assert.ok(issues.some((issue) => issue.includes('ASSETS')));
	assert.ok(issues.some((issue) => issue.includes('ARTICLE_EVENTS')));
});

test('Workers Builds requires an explicit preview-only command attestation', () => {
	assert.deepEqual(validateWorkersBuildEnvironment({
		WORKERS_CI: '1',
		WORKERS_CI_COMMIT_SHA: 'a'.repeat(40),
		ZEMIONE_WORKERS_DEPLOY_COMMAND: 'npm run deploy:workers-build',
	}), []);
	assert.ok(validateWorkersBuildEnvironment({ WORKERS_CI: '1' }).length >= 2);
});

test('rendered production HTML must retain the rich site shell', () => {
	assert.deepEqual(validateRenderedHtml('<html><head><link rel="stylesheet" href="/_astro/a.css"></head><body><header class="site-header"></header><article class="article-card"></article></body></html>'), []);
	assert.ok(validateRenderedHtml('<html><body><a>simple list</a></body></html>').length >= 3);
});
