import starlight from '@astrojs/starlight';
// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://yarychh.github.io',
  base: '/querykeep',
  integrations: [
    starlight({
      title: 'Querykeep',
      description: 'Shared in-memory snapshots of asynchronous sources, with admission and retries',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/yarychh/querykeep',
        },
      ],
      sidebar: [
        { label: 'Quickstart', slug: 'index' },
        { label: 'Why Querykeep', slug: 'why' },
        {
          label: 'Guides',
          items: [
            { label: 'State', slug: 'guides/state' },
            { label: 'Admission', slug: 'guides/admission' },
            { label: 'Persistence', slug: 'guides/persistence' },
            { label: 'Limits', slug: 'guides/limits' },
            { label: 'Recipes', slug: 'guides/recipes' },
          ],
        },
        {
          label: 'Reference',
          items: [{ label: 'API', slug: 'reference/api' }],
        },
      ],
    }),
  ],
});
