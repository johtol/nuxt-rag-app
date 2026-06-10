import tailwindcss from "@tailwindcss/vite";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: [
    '@nuxt/eslint',
  ],
  devtools: { enabled: true },
  vite:{
      plugins:[
          tailwindcss()
      ]
  },
  css: ['~/assets/css/main.css'],
  routeRules: {
    '/': { prerender: true }
  },
  eslint: {
      config: {
          stylistic: {
              commaDangle: 'never',
              braceStyle: '1tbs'
          }
      }
  }
})
