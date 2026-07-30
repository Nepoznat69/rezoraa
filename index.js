// Kompatibilni ulaz za ranije korisnike komande `node index.js`.
// Prije pokretanja izvršite `npm run build`.
import('./dist/qr-agent.js').catch((error) => {
  console.error('QR Agent nije izgrađen. Pokrenite: npm run build');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

