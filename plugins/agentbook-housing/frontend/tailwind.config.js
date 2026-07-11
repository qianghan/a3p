import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const typography = require('@tailwindcss/typography');
const forms = require('@tailwindcss/forms');
import tailwindExtend from '../../../packages/theme/tailwind-extend.cjs';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: tailwindExtend,
  },
  plugins: [typography, forms],
};
