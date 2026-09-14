import { createHmac } from 'node:crypto';
import type { IDataObject, INode } from 'n8n-workflow';

/**
 * The little n8n does for a node at runtime, in plain objects: credentials,
 * parameters, the workflow's static data and an HTTP helper that answers from
 * a routing table and records what it was asked. Enough to run the real node
 * code without an n8n instance.
 */

export const BASE_URL = 'https://tirodocs.com/api/v1';
export const WEBHOOK_URL = 'https://n8n.example.com/webhook/8f2c-tiro';
export const SECRET = 'whsec_test-secret';

export type Recorded = { method: string; url: string; body?: unknown; headers?: IDataObject };
export type Answer = { status?: number; body?: unknown };
export type Route = (request: Recorded) => Answer;

export const node: INode = {
	id: 'n1',
	name: 'Tiro',
	type: 'n8n-nodes-tiro.tiro',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export function makeContext(options: {
	parameters?: IDataObject;
	staticData?: IDataObject;
	route?: Route;
	binary?: { data: Buffer; fileName?: string; mimeType?: string };
	request?: { rawBody?: Buffer; body?: unknown };
	headers?: Record<string, string>;
	body?: IDataObject;
}) {
	const calls: Recorded[] = [];
	const staticData = options.staticData ?? {};
	const context = {
		calls,
		staticData,
		getNode: () => node,
		getCredentials: async () => ({ apiKey: 'key', baseUrl: BASE_URL }),
		getNodeParameter: (name: string, _index?: unknown, fallback?: unknown) =>
			(options.parameters ?? {})[name] ?? fallback,
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => WEBHOOK_URL,
		getRequestObject: () => options.request ?? {},
		getBodyData: () => options.body ?? {},
		getHeaderData: () => options.headers ?? {},
		getInputData: () => [{ json: {} }],
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_type: string, request: Recorded) => {
				calls.push(request);
				const answer = options.route ? options.route(request) : {};
				return { statusCode: answer.status ?? 200, body: answer.body ?? {} };
			},
			assertBinaryData: () => ({
				fileName: options.binary?.fileName,
				mimeType: options.binary?.mimeType,
			}),
			getBinaryDataBuffer: async () => options.binary?.data ?? Buffer.from(''),
		},
	};
	return context;
}

/** A webhook call the way Tiro sends it: signed body, matching timestamp. */
export function signedRequest(payload: unknown, secret = SECRET) {
	const body = JSON.stringify(payload);
	const timestamp = Math.floor(Date.now() / 1000);
	const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
	return {
		request: { rawBody: Buffer.from(body, 'utf8') },
		headers: {
			'x-tiro-timestamp': String(timestamp),
			'x-tiro-signature': `v1=${signature}`,
		},
	};
}

export const INBOX = { id: 'inbox-1', name: 'Order confirmations' };

export const DOCUMENT = {
	id: 'doc-1',
	filename: 'order-confirmation-4711.pdf',
	kind: 'pdf',
	content_type: 'application/pdf',
	pages: 2,
	credits: 2,
	source: 'email',
	status: 'done',
	error: null,
	created_at: '2026-09-12T09:14:40Z',
};

export const EXTRACT_PAYLOAD = {
	event: 'extract.completed',
	id: 'delivery-1',
	created_at: '2026-09-12T09:15:02Z',
	inbox: INBOX,
	document: DOCUMENT,
	extract: {
		data: {
			document_number: 'AB-2026-4711',
			total: 1234.5,
			line_items: [
				{ description: 'Steel bracket', quantity: 12, amount: 106.8 },
				{ description: 'Assembly', quantity: 1, amount: 1127.7 },
			],
		},
		created_at: '2026-09-12T09:15:02Z',
	},
	links: {
		document: '/api/v1/inboxes/inbox-1/documents/doc-1',
		download_csv: '/api/v1/inboxes/inbox-1/documents/doc-1/download?format=csv',
		download_xlsx: '/api/v1/inboxes/inbox-1/documents/doc-1/download?format=xlsx',
	},
};

export const FAILURE_PAYLOAD = {
	event: 'document.failed',
	id: 'delivery-2',
	created_at: '2026-09-12T09:20:00Z',
	inbox: INBOX,
	document: {
		...DOCUMENT,
		id: 'doc-2',
		status: 'failed',
		error: 'Das Dokument konnte nicht verarbeitet werden.',
	},
	extract: null,
};
