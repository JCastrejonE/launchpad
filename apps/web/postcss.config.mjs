/** Tailwind v4's PostCSS plugin (spec 0016 item 4 — shadcn/ui scaffold). No
 * tailwind.config.js needed: v4 configures via CSS (see app/globals.css) and
 * scans source files for class names automatically. */
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
