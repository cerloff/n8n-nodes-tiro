// n8n's own verification lint (npx n8n-node lint) — the rules the Creator
// Portal checks. Tests stay out: they run on Node's test runner, which the
// cloud-compatibility rules forbid for shipped node code.
import { config } from '@n8n/node-cli/eslint';

export default [...config, { ignores: ['dist/**', 'test/**', 'scripts/**'] }];
