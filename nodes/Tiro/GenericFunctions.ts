import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodePropertyOptions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/**
 * Everything the two Tiro nodes share: where the API is, how its answers are
 * read, how a signed webhook is verified and how Tiro's wire formats become
 * the items an n8n workflow works with. No logic here that the API does not
 * already enforce — the node is a thin client of `/v1` (TASKS 3.2).
 */

export const DEFAULT_BASE_URL = 'https://tirodocs.com/api/v1';
const USER_AGENT = 'Tiro-n8n/1.0';
/** How far a webhook's timestamp may be off before it counts as a replay. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export type TiroContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

export type TiroResponse = { status: number; body: IDataObject };

/** Trigger modes of the trigger node → the event a destination subscribes to. */
export const EVENT_EXTRACT_COMPLETED = 'extract.completed';
export const EVENT_DOCUMENT_FAILED = 'document.failed';
export const MODE_EXTRACT = 'extract';
export const MODE_ROW = 'row';
export const MODE_FAILURE = 'failure';

export function apiEvent(mode: string): string {
	return mode === MODE_FAILURE ? EVENT_DOCUMENT_FAILED : EVENT_EXTRACT_COMPLETED;
}

const trimSlash = (value: string): string => value.replace(/\/$/, '');

export async function baseUrl(this: TiroContext): Promise<string> {
	const credentials = await this.getCredentials('tiroApi');
	const configured = (credentials.baseUrl as string) || DEFAULT_BASE_URL;
	return trimSlash(configured.trim());
}

/** Public host the API links (`/api/v1/...`) and the app pages live on. */
export function appUrl(api: string): string {
	const match = /^(https?:\/\/[^/]+)/.exec(api);
	return match ? match[1] : trimSlash(DEFAULT_BASE_URL).replace('/api/v1', '');
}

/** n8n's UI is English, so people land on the English app. */
export function documentPageUrl(api: string, inboxId: string, documentId: string): string {
	return `${appUrl(api)}/en/app/inboxes/${inboxId}/documents/${documentId}`;
}

/** The API hands out relative links (`/api/v1/...`); a workflow needs absolute ones. */
export function absoluteLink(api: string, path: string): string {
	return path.startsWith('/') ? `${appUrl(api)}${path}` : path;
}

/**
 * A call to Tiro with its own error messages kept intact: the API puts the
 * reason a person can act on in `detail` (413 too large, 415 unsupported type,
 * 429 out of credits, 422 refused input); 401/403 mean the key is gone. Pass
 * `allow: [404]` to get such answers back instead of an error.
 */
export async function tiroApiRequest(
	this: TiroContext,
	method: IHttpRequestMethods,
	path: string,
	options: {
		body?: IHttpRequestOptions['body'];
		qs?: IDataObject;
		headers?: IDataObject;
		allow?: number[];
	} = {},
): Promise<TiroResponse> {
	const url = `${await baseUrl.call(this)}${path}`;
	const response = await this.helpers.httpRequestWithAuthentication.call(this, 'tiroApi', {
		method,
		url,
		body: options.body,
		qs: options.qs,
		headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	});
	const status = response.statusCode as number;
	const body = (response.body ?? {}) as IDataObject;
	if (status < 400 || (options.allow ?? []).includes(status)) return { status, body };
	throw new NodeApiError(this.getNode(), body as JsonObject, {
		message: detailOf(body) ?? `Tiro answered with HTTP ${status}.`,
		httpCode: String(status),
	});
}

function detailOf(body: IDataObject): string | null {
	const detail = body.detail;
	if (typeof detail === 'string') return detail;
	if (Array.isArray(detail)) {
		return detail
			.map((item) => (item as IDataObject)?.msg ?? JSON.stringify(item))
			.join('; ');
	}
	return null;
}

/** Powers the inbox dropdown of both nodes. */
export async function loadInboxes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const response = await tiroApiRequest.call(this, 'GET', '/inboxes');
	const inboxes = (response.body as unknown as IDataObject[]) ?? [];
	return inboxes.map((inbox) => ({ name: inbox.name as string, value: inbox.id as string }));
}

// --- upload ---------------------------------------------------------------------------

/**
 * One file as a multipart/form-data body, built here instead of by a library:
 * a verified community node must ship without runtime dependencies, and the
 * format is three header lines around the bytes.
 *
 * File name and content type come from the workflow, so they are stripped of
 * everything that could open a header line of its own.
 */
export function multipartFile(
	file: Buffer,
	filename: string,
	contentType: string,
): { body: Buffer; contentType: string } {
	const boundary = randomBytes(16).toString('hex');
	const head =
		`--${boundary}\r\n` +
		`Content-Disposition: form-data; name="file"; filename="${headerSafe(filename).replace(/"/g, '%22')}"\r\n` +
		`Content-Type: ${headerSafe(contentType)}\r\n\r\n`;
	return {
		body: Buffer.concat([Buffer.from(head, 'utf8'), file, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

const headerSafe = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

// --- mapping --------------------------------------------------------------------------

export type TiroPayload = {
	event: string;
	id: string;
	created_at: string;
	inbox: IDataObject;
	document: IDataObject;
	extract: { data: IDataObject; created_at: string } | null;
	links?: IDataObject;
};

/**
 * Tiro's timestamps are naive UTC; the API prints them without a zone
 * ("2026-09-08T09:15:02.123456") while the webhook says "…Z". A workflow wants
 * one format, so every timestamp leaves here as ISO 8601 with an explicit zone.
 */
export function iso(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	const text = String(value);
	return /(Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`;
}

/** An inbox has at most one table field: its value is the only array of rows. */
export function splitFields(data: IDataObject | null | undefined): {
	fields: IDataObject;
	rowsField: string | null;
	rows: IDataObject[];
} {
	const fields: IDataObject = {};
	let rowsField: string | null = null;
	let rows: IDataObject[] = [];
	for (const [key, value] of Object.entries(data ?? {})) {
		if (Array.isArray(value) && rowsField === null) {
			rowsField = key;
			rows = value.filter((row) => row && typeof row === 'object') as IDataObject[];
		} else {
			fields[key] = value;
		}
	}
	return { fields, rowsField, rows };
}

/** Stable per document *run*: a reprocessed document is new, a retried delivery is not. */
function runId(documentId: string, moment: string | null): string {
	return `${documentId}:${moment ?? 'run'}`;
}

/** One finished extract — the trigger item and the result of "Get Extract". */
export function extractItem(
	api: string,
	{
		inbox,
		document,
		extract,
		links = {},
	}: {
		inbox: IDataObject;
		document: IDataObject;
		extract: { data: IDataObject; created_at: string } | null;
		links?: IDataObject;
	},
): IDataObject {
	const { fields, rowsField, rows } = splitFields(extract?.data);
	const extractedAt = extract?.created_at ?? null;
	const base = `/api/v1/inboxes/${inbox.id}/documents/${document.id}`;
	return {
		id: runId(document.id as string, iso(extractedAt)),
		document_id: document.id,
		inbox_id: inbox.id,
		inbox_name: inbox.name,
		filename: document.filename,
		kind: document.kind,
		content_type: document.content_type,
		pages: document.pages,
		credits: document.credits,
		source: document.source,
		status: document.status,
		review_status: document.review_status ?? null,
		document_created_at: iso(document.created_at),
		extracted_at: iso(extractedAt),
		fields,
		rows_field: rowsField,
		row_count: rows.length,
		rows,
		document_url: documentPageUrl(api, inbox.id as string, document.id as string),
		csv_url: absoluteLink(api, (links.download_csv as string) ?? `${base}/download?format=csv`),
		xlsx_url: absoluteLink(api, (links.download_xlsx as string) ?? `${base}/download?format=xlsx`),
	};
}

/** One item per table row, the header fields repeated on each. */
export function rowItems(item: IDataObject): IDataObject[] {
	const rows = (item.rows as IDataObject[]) ?? [];
	return rows.map((row, index) => ({
		id: `${item.id}:${index + 1}`,
		row_index: index + 1,
		row_count: item.row_count,
		document_id: item.document_id,
		inbox_id: item.inbox_id,
		inbox_name: item.inbox_name,
		filename: item.filename,
		extracted_at: item.extracted_at,
		document_url: item.document_url,
		fields: item.fields,
		row,
	}));
}

/** A document that failed for good: its user-facing error, no extract. */
export function failureItem(
	api: string,
	{
		inbox,
		document,
		failedAt,
	}: { inbox: IDataObject; document: IDataObject; failedAt: string | null },
): IDataObject {
	return {
		id: runId(document.id as string, iso(failedAt ?? document.created_at)),
		document_id: document.id,
		inbox_id: inbox.id,
		inbox_name: inbox.name,
		filename: document.filename,
		kind: document.kind,
		content_type: document.content_type,
		pages: document.pages,
		credits: document.credits,
		source: document.source,
		status: document.status,
		error: document.error,
		document_created_at: iso(document.created_at),
		failed_at: iso(failedAt),
		document_url: documentPageUrl(api, inbox.id as string, document.id as string),
	};
}

export function itemsFromPayload(api: string, payload: TiroPayload, mode: string): IDataObject[] {
	if (mode === MODE_FAILURE) {
		if (payload.event !== EVENT_DOCUMENT_FAILED) return [];
		return [
			failureItem(api, {
				inbox: payload.inbox,
				document: payload.document,
				failedAt: payload.created_at,
			}),
		];
	}
	if (payload.event !== EVENT_EXTRACT_COMPLETED || !payload.extract) return [];
	const item = extractItem(api, {
		inbox: payload.inbox,
		document: payload.document,
		extract: payload.extract,
		links: payload.links,
	});
	return mode === MODE_ROW ? rowItems(item) : [item];
}

// --- signature ------------------------------------------------------------------------

/**
 * Tiro signs every webhook: `X-Tiro-Signature: v1=<hex HMAC-SHA256(secret,
 * "<timestamp>.<body>")>` with `X-Tiro-Timestamp` in Unix seconds — the same
 * scheme as tiro_api/destinations/webhooks.py. The subscribe call handed the
 * secret to this node; a call without a matching signature never starts a
 * workflow.
 */
export function sign(secret: string, timestamp: string | number, body: string): string {
	return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifySignature(
	secret: string,
	timestamp: string | undefined,
	body: string,
	header: string | undefined,
	now = Date.now() / 1000,
): boolean {
	if (!secret || !timestamp || !header) return false;
	const moment = Number(timestamp);
	if (!Number.isFinite(moment) || Math.abs(now - moment) > SIGNATURE_TOLERANCE_SECONDS) return false;
	const expected = Buffer.from(`v1=${sign(secret, timestamp, body)}`);
	const given = Buffer.from(header);
	return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The bytes Tiro signed — n8n keeps them next to the parsed body. */
/** Only what we read off the incoming request — express types stay out of the node. */
type RawRequest = { rawBody?: Buffer | string; body?: unknown };

export function rawBodyText(node: INode, request: RawRequest, parsed: IDataObject): string {
	const raw: unknown = request.rawBody ?? request.body;
	if (Buffer.isBuffer(raw)) return raw.toString('utf8');
	if (typeof raw === 'string' && raw !== '') return raw;
	// Nothing raw available: the parsed body cannot prove the signature, and an
	// unverified call must never start a workflow.
	if (parsed && Object.keys(parsed).length > 0) {
		throw new NodeOperationError(
			node,
			'The webhook could not be verified because n8n did not keep the raw request body.',
		);
	}
	return '';
}

export function assertSignedHook(
	node: INode,
	secret: string | undefined,
	headers: Record<string, unknown>,
	body: string,
): void {
	const value = (name: string): string | undefined => {
		const found = headers[name];
		return Array.isArray(found) ? String(found[0]) : found === undefined ? undefined : String(found);
	};
	if (!secret) {
		throw new NodeOperationError(
			node,
			'This trigger has no signing secret yet — save the workflow again so the node re-subscribes in Tiro.',
		);
	}
	if (!verifySignature(secret, value('x-tiro-timestamp'), body, value('x-tiro-signature'))) {
		throw new NodeOperationError(
			node,
			'The webhook signature does not match — the call did not come from Tiro.',
		);
	}
}
