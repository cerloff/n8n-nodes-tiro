import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * One workspace API key (Tiro → Account → API keys). The same key serves the
 * REST API, the MCP server and this node; Tiro's tenant guard applies
 * unchanged, so a key never reaches anything outside its workspace.
 */
export class TiroApi implements ICredentialType {
	name = 'tiroApi';

	displayName = 'Tiro API';

	icon: Icon = { light: 'file:tiro.svg', dark: 'file:tiro.dark.svg' };

	documentationUrl = 'https://tirodocs.com/en/integrations/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Create a key in Tiro under Account → API keys (shown once). It grants access to the whole workspace — keep it private.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://tirodocs.com/api/v1',
			description: 'Only change this when you run Tiro yourself',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/inboxes',
		},
	};
}
