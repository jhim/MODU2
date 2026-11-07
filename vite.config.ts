import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // Supabase's Vercel integration provides these values without a VITE_/NEXT_PUBLIC_ prefix.
  // Expose only the public URL and anon key to the browser bundle; never expose SUPABASE_* broadly.
  const rootEnv = loadEnv(mode, process.cwd(), '');
  const clientEnv = loadEnv(mode, `${process.cwd()}/client`, '');
  const publicUrl = clientEnv.VITE_SUPABASE_URL || rootEnv.VITE_SUPABASE_URL
    || clientEnv.NEXT_PUBLIC_SUPABASE_URL || rootEnv.NEXT_PUBLIC_SUPABASE_URL || rootEnv.SUPABASE_URL;
  const publicAnonKey = clientEnv.VITE_SUPABASE_ANON_KEY || rootEnv.VITE_SUPABASE_ANON_KEY
    || clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || rootEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || rootEnv.SUPABASE_ANON_KEY;

  return {
    root: 'client',
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(publicUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(publicAnonKey),
    },
    plugins: [react(), tailwindcss()],
    server: { proxy: { '/api': 'http://localhost:3000' } },
    build: { outDir: '../public', emptyOutDir: true },
    test: { environment: 'node', include: ['../tests/unit/**/*.test.ts', '../tests/api/**/*.test.ts'] }
  };
});
