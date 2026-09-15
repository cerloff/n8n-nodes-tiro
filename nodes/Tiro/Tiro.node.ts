import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import {
	baseUrl,
	documentPageUrl,
	extractItem,
	loadInboxes,
	multipartFile,
	tiroApiRequest,
} from './GenericFunctions';

/**
 * The two things a workflow does towards Tiro: put a document in, and read a
 * finished result back. Processing runs in Tiro's background — the upload
 * answers with the document (status `uploaded`/`processing`), the result
 * arrives through the Tiro Trigger node or, after a Wait step, through
 * "Get Extract".
 */
export class Tiro implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Tiro',
		name: 'tiro',
		icon: { light: 'file:tiro.svg', dark: 'file:tiro.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Upload documents to Tiro and read extracted data',
		defaults: { name: 'Tiro' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'tiroApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'document',
				options: [
					{ name: 'Document', value: 'document' },
					{ name: 'Extract', value: 'extract' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['document'] } },
				default: 'upload',
				options: [
					{
						name: 'Upload',
						value: 'upload',
						description: 'Upload a file into an inbox',
						action: 'Upload a document',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['extract'] } },
				default: 'get',
				options: [
					{
						name: 'Get',
						value: 'get',
						description: 'Get the extracted data of a document',
						action: 'Get an extract',
					},
				],
			},
			{
				displayName: 'Inbox Name or ID',
				name: 'inboxId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getInboxes' },
				default: '',
				required: true,
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { resource: ['document'], operation: ['upload'] } },
				description:
					'Name of the binary field that holds the file: PDF, JPEG/PNG/HEIC/WebP, DOCX/XLSX/PPTX. Max. 10 MB.',
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['document'], operation: ['upload'] } },
				description:
					'Optional. Shown in Tiro and in exports; defaults to the name of the binary file.',
			},
			{
				displayName: 'Document ID',
				name: 'documentId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['extract'], operation: ['get'] } },
				description: 'The ID the upload returned (also part of the document URL in the app)',
			},
		],
	};

	methods = {
		loadOptions: { getInboxes: loadInboxes },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const api = await baseUrl.call(this);
		const out: INodeExecutionData[] = [];
		// One inbox is usually enough for the whole run; its field definitions
		// never change mid-execution.
		const inboxes = new Map<string, IDataObject>();

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const inboxId = this.getNodeParameter('inboxId', i) as string;
				const json =
					resource === 'document'
						? await uploadDocument.call(this, api, inboxId, i)
						: await getExtract.call(this, api, inboxId, i, inboxes);
				out.push({ json, pairedItem: { item: i } });
			} catch (error) {
				// Our own errors already carry the API's wording; anything else
				// (a broken binary field, a socket error) gets the node context.
				const failure =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeApiError(this.getNode(), error as JsonObject);
				if (!this.continueOnFail()) throw failure;
				out.push({ json: { error: failure.message }, pairedItem: { item: i } });
			}
		}
		return [out];
	}
}

/**
 * Credits are charged at intake like every upload; 429 means the workspace is
 * out of credits, 413/415 that the file is too big or of an unsupported kind —
 * the API's own wording reaches the workflow.
 */
async function uploadDocument(
	this: IExecuteFunctions,
	api: string,
	inboxId: string,
	index: number,
): Promise<IDataObject> {
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', index) as string;
	const binary = this.helpers.assertBinaryData(index, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(index, binaryPropertyName);
	const chosen = (this.getNodeParameter('fileName', index, '') as string).trim();

	const form = multipartFile(
		buffer,
		chosen || binary.fileName || 'document',
		binary.mimeType || 'application/octet-stream',
	);
	const response = await tiroApiRequest.call(this, 'POST', `/inboxes/${inboxId}/documents`, {
		body: form.body,
		headers: { 'Content-Type': form.contentType },
	});
	const document = response.body;
	return { ...document, document_url: documentPageUrl(api, inboxId, document.id as string) };
}

/**
 * The result of one document — the second half of "Upload → Wait → Get
 * Extract". A document that does not exist or is not finished yet is not an
 * error but `found: false`, so a workflow can branch on it (and an IF node can
 * loop back into the Wait step).
 */
async function getExtract(
	this: IExecuteFunctions,
	api: string,
	inboxId: string,
	index: number,
	inboxes: Map<string, IDataObject>,
): Promise<IDataObject> {
	const documentId = this.getNodeParameter('documentId', index) as string;
	const base = `/inboxes/${inboxId}/documents/${documentId}`;
	const document = await tiroApiRequest.call(this, 'GET', base, { allow: [404] });
	if (document.status === 404) {
		return { found: false, inbox_id: inboxId, document_id: documentId, status: null };
	}
	if (document.body.status !== 'done') {
		return {
			found: false,
			inbox_id: inboxId,
			document_id: documentId,
			status: document.body.status,
		};
	}
	const extract = await tiroApiRequest.call(this, 'GET', `${base}/extract`, { allow: [404] });
	if (extract.status === 404) {
		return { found: false, inbox_id: inboxId, document_id: documentId, status: 'done' };
	}
	if (!inboxes.has(inboxId)) {
		inboxes.set(inboxId, (await tiroApiRequest.call(this, 'GET', `/inboxes/${inboxId}`)).body);
	}
	return {
		found: true,
		...extractItem(api, {
			inbox: inboxes.get(inboxId) as IDataObject,
			document: document.body,
			extract: extract.body as unknown as { data: IDataObject; created_at: string },
		}),
	};
}
