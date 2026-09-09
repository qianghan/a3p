import { DocsLanding } from '@/components/docs/docs-landing';

export const metadata = {
  title: 'AgentBook Docs',
  description: 'Guides for setting up and using AgentBook — AI bookkeeping for your business and personal finances.',
};


export default function DocsHomePage() {
  return <DocsLanding locale="en" />;
}
