import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import {
	MODE_EXTRACT,
	MODE_FAILURE,
	MODE_ROW,
	apiEvent,
	assertSignedHook,
	baseUrl,
	itemsFromPayload,
	loadInboxes,
	rawBodyText,
	tiroApiRequest,
	type TiroPayload,
} from './GenericFunctions';

type Subscription = { destinationId?: string; secret?: string; url?: string; event?: string };

/**
 * Starts a workflow when Tiro has finished a document. The node subscribes as
 * a destination of type `n8n` (a signed webhook inside Tiro: same retries,
 * same SSRF rules, same review gate — an inbox that reviews releases only
 * approved results), so there is no polling and no empty execution.
 */
export class TiroTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Tiro Trigger',
		name: 'tiroTrigger',
		icon: 'file:tiro.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow when Tiro finishes a document',
		defaults: { name: 'Tiro Trigger' },
		inputs: [],
		// Plain 'main' instead of the NodeConnectionTypes constant: the literal
		// works on every n8n version this node may be installed on.
		outputs: ['main'],
		credentials: [{ name: 'tiroApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
				rawBody: true,
			},
		],
		properties: [
			{
				displayName: 'Inbox Name or ID',
				name: 'inboxId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getInboxes' },
				default: '',
				required: true,
				description:
					'The inbox whose documents start this workflow. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Trigger On',
				name: 'event',
				type: 'options',
				default: MODE_EXTRACT,
				options: [
					{
						name: 'Extract Completed',
						value: MODE_EXTRACT,
						description: 'One item per document: header fields plus all table rows',
					},
					{
						name: 'Extract Completed (One Item per Row)',
						value: MODE_ROW,
						description: 'One item per table row, with the header fields on every row',
					},
					{
						name: 'Document Failed',
						value: MODE_FAILURE,
						description: 'One item per document that failed for good, with its error message',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: { getInboxes: loadInboxes },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as Subscription;
				if (!data.destinationId) return false;
				const wanted = this.getNodeWebhookUrl('default');
				const event = apiEvent(this.getNodeParameter('event') as string);
				const response = await tiroApiRequest.call(
					this,
					'GET',
					`/destinations/${data.destinationId}`,
					{ allow: [404] },
				);
				const destination = response.body;
				const matches =
					response.status === 200 &&
					destination.url === wanted &&
					destination.event === event &&
					destination.inbox_id === this.getNodeParameter('inboxId') &&
					destination.active === true;
				if (matches) return true;
				// Points somewhere else (URL, inbox or event changed): drop it, so
				// `create` does not leave a second destination behind in Tiro.
				if (response.status === 200) {
					await tiroApiRequest.call(this, 'DELETE', `/destinations/${data.destinationId}`, {
						allow: [404],
					});
				}
				delete data.destinationId;
				delete data.secret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as Subscription;
				const url = this.getNodeWebhookUrl('default') as string;
				const event = apiEvent(this.getNodeParameter('event') as string);
				const response = await tiroApiRequest.call(this, 'POST', '/destinations', {
					body: {
						inbox_id: this.getNodeParameter('inboxId') as string,
						url,
						type: 'n8n',
						event,
					},
				});
				// `destinationId` unsubscribes, `secret` verifies every call.
				data.destinationId = response.body.id as string;
				data.secret = response.body.secret as string;
				data.url = url;
				data.event = event;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as Subscription;
				if (data.destinationId) {
					// Already gone (deleted in the app) is fine — the goal is "no destination".
					await tiroApiRequest.call(this, 'DELETE', `/destinations/${data.destinationId}`, {
						allow: [404],
					});
				}
				delete data.destinationId;
				delete data.secret;
				delete data.url;
				delete data.event;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const data = this.getWorkflowStaticData('node') as Subscription;
		const node = this.getNode();
		const body = rawBodyText(node, this.getRequestObject(), this.getBodyData());
		assertSignedHook(node, data.secret, this.getHeaderData() as Record<string, unknown>, body);

		const payload = JSON.parse(body) as TiroPayload;
		const mode = this.getNodeParameter('event') as string;
		const items = itemsFromPayload(await baseUrl.call(this), payload, mode);
		// Anything else Tiro may send (a test call, another event) is answered
		// with 200 and starts nothing.
		if (items.length === 0) return {};
		return { workflowData: [items.map((json: IDataObject) => ({ json }))] };
	}
}
