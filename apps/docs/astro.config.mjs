import starlight from '@astrojs/starlight';
// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: 'Querykeep',
      description: 'Single-process managed query store',
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
