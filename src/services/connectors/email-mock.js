// email-mock connector (design §3): a simulated send for rush buyers and for visitors over the real-email cap.
// Nothing leaves the process.
import { UnsupportedActionError, classifyHttpError } from './http-errors.js';

export function createMockEmailConnector() {
  return {
    id: 'email-mock',
    capabilities: ['email.send'],
    async execute(action) {
      if (action !== 'email.send') throw new UnsupportedActionError(`email-mock has no action ${action}`);
      return { simulated: true };
    },
    classifyError: classifyHttpError,
    healthCheck: async () => true,
  };
}
