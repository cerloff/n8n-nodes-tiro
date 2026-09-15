import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ILoadOptionsFunctions, INodeType } from 'n8n-workflow';
import { TiroApi } from '../credentials/TiroApi.credentials';
import { Tiro } from '../nodes/Tiro/Tiro.node';
import { TiroTrigger } from '../nodes/Tiro/TiroTrigger.node';
import { loadInboxes, multipartFile, verifySignature } from '../nodes/Tiro/GenericFunctions';
import { makeContext } from './helpers';

const nodes: INodeType[] = [new Tiro(), new TiroTrigger()];

test('n8n finds everything package.json promises it', () => {
	const root = join(__dirname, '..', '..');
	const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
		n8n: { nodes: string[]; credentials: string[] };
	};
	for (const path of [...packageJson.n8n.nodes, ...packageJson.n8n.credentials]) {
		assert.ok(existsSync(join(root, path)), `${path} is missing from the build`);
	}
	// The icons are copied next to the compiled nodes, not compiled.
	assert.ok(existsSync(join(root, 'dist/nodes/Tiro/tiro.svg')));
	assert.ok(existsSync(join(root, 'dist/nodes/Tiro/tiro.dark.svg')));
	assert.ok(existsSync(join(root, 'dist/nodes/Tiro/Tiro.node.json')));
});

test('the package has no runtime dependencies', () => {
	const packageJson = JSON.parse(
		readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
	) as { dependencies?: Record<string, string> };
	// n8n refuses to verify a community node that installs anything at runtime,
	// which is why the multipart body is built by hand (GenericFunctions).
	assert.deepEqual(packageJson.dependencies ?? {}, {});
});

test('both nodes are described the way n8n expects', () => {
	for (const node of nodes) {
		const description = node.description;
		assert.deepEqual(description.icon, { light: 'file:tiro.svg', dark: 'file:tiro.dark.svg' });
		assert.deepEqual(description.credentials, [{ name: 'tiroApi', required: true }]);
		assert.deepEqual(description.outputs, ['main']); // NodeConnectionTypes.Main
		for (const property of description.properties) {
			// Every parameter needs a default, or n8n cannot render the node.
			assert.notEqual(property.default, undefined, `${property.name} has no default`);
			assert.ok(property.displayName, `${property.name} has no label`);
		}
	}
	const [, trigger] = nodes;
	assert.deepEqual(trigger.description.inputs, []);
	assert.equal(trigger.description.webhooks?.[0].httpMethod, 'POST');
});

test('the credential holds the workspace key and proves itself against the API', () => {
	const credential = new TiroApi();
	assert.equal(credential.name, 'tiroApi');
	const [apiKey, baseUrl] = credential.properties;
	assert.equal(apiKey.typeOptions?.password, true);
	assert.equal(baseUrl.default, 'https://tirodocs.com/api/v1');
	assert.equal(
		credential.authenticate.properties.headers?.Authorization,
		'=Bearer {{$credentials.apiKey}}',
	);
	assert.equal(credential.test.request.url, '/inboxes');
});

test('the inbox dropdown lists the workspace inboxes', async () => {
	const context = makeContext({
		route: () => ({
			body: [
				{ id: 'inbox-1', name: 'Order confirmations' },
				{ id: 'inbox-2', name: 'Delivery notes' },
			],
		}),
	});

	const options = await loadInboxes.call(context as unknown as ILoadOptionsFunctions);

	assert.deepEqual(options, [
		{ name: 'Order confirmations', value: 'inbox-1' },
		{ name: 'Delivery notes', value: 'inbox-2' },
	]);
	assert.equal(context.calls[0].url, 'https://tirodocs.com/api/v1/inboxes');
});

test('a replayed call is refused even with a correct signature', () => {
	const secret = 'whsec_test-secret';
	const body = '{"event":"extract.completed"}';
	const timestamp = 1_760_000_000;
	const { createHmac } = require('node:crypto') as typeof import('node:crypto');
	const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

	assert.equal(verifySignature(secret, String(timestamp), body, signature, timestamp + 10), true);
	// Ten minutes later the same call is a replay.
	assert.equal(verifySignature(secret, String(timestamp), body, signature, timestamp + 600), false);
});

test('the multipart body is built by hand — a verified node ships no runtime dependency', () => {
	const { body, contentType } = multipartFile(Buffer.from('%PDF-1.7 x'), 'rechnung 42.pdf', 'application/pdf');
	const boundary = /boundary=([0-9a-f]+)$/.exec(contentType)?.[1];

	assert.ok(boundary, `no boundary in ${contentType}`);
	assert.equal(
		body.toString('utf8'),
		`--${boundary}\r\n` +
			'Content-Disposition: form-data; name="file"; filename="rechnung 42.pdf"\r\n' +
			'Content-Type: application/pdf\r\n\r\n' +
			'%PDF-1.7 x\r\n' +
			`--${boundary}--\r\n`,
	);
});

test('a file name cannot smuggle headers into the request', () => {
	const { body } = multipartFile(
		Buffer.from('x'),
		'evil".pdf\r\nX-Injected: 1',
		'application/pdf\r\nX-Also: 1',
	);

	const text = body.toString('utf8');
	assert.match(text, /filename="evil%22.pdf X-Injected: 1"/);
	assert.match(text, /Content-Type: application\/pdf X-Also: 1\r\n/);
	// Exactly the three header lines we wrote — nothing the name added.
	assert.equal(text.split('\r\n').length, 7);
});
