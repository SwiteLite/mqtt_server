/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {
  compilerOptions: {
    // Garde la réactivité classique (let / $:) — évite l'UI figée avec Svelte 5
    runes: false
  }
};
