// Gera latest.json do Tauri updater a partir dos bundles já baixados em dist/.
// Uso (CI): TAG=v0.2.5 GITHUB_REPOSITORY=owner/repo node scripts/latest-json.mjs
//
// Chaves = `{os}-{arch}-{installer}`, que é o lookup do plugin
// (`tauri-plugin-updater/src/updater.rs` get_urls: tenta `{os}-{arch}-{installer}`,
// depois `{os}-{arch}`). NÃO emitir a chave sem sufixo: um `.deb` cairia no
// fallback e receberia o AppImage.
//
// Tauri v2 assina o bundle em si (verificado com `tauri build --bundles deb,appimage`
// + createUpdaterArtifacts): `.deb.sig`, `.rpm.sig`, `.AppImage.sig`. O AppImage
// obriga presença; os outros entram se existirem, senão só avisam.
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.TAG;
if (!repo || !tag) throw new Error('GITHUB_REPOSITORY e TAG são obrigatórios');

const files = [];
const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = join(d, e.name);
  if (e.isDirectory()) walk(p);
  else files.push(p);
});
walk('dist');

// Um alvo por instalador conhecido; `re` casam o nome do artefato assinado.
const TARGETS = [
  { key: 'linux-x86_64-appimage', re: /\.AppImage$/, required: true },
  { key: 'linux-x86_64-deb', re: /\.deb$/, required: false },
  { key: 'linux-x86_64-rpm', re: /\.rpm$/, required: false },
  { key: 'windows-x86_64-nsis', re: /(\.exe|\.nsis\.zip)$/, required: false },
  { key: 'windows-x86_64-msi', re: /(\.msi|\.msi\.zip)$/, required: false },
];

const platforms = {};
for (const t of TARGETS) {
  const file = files.find((f) => t.re.test(f) && !f.endsWith('.sig'));
  if (!file) {
    if (t.required) throw new Error(`artefato obrigatório ausente em dist/: ${t.key}`);
    console.log(`aviso: sem artefato para ${t.key}`);
    continue;
  }
  const sigPath = file + '.sig';
  if (!existsSync(sigPath)) throw new Error('sem assinatura: ' + file);
  platforms[t.key] = {
    signature: readFileSync(sigPath, 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${basename(file)}`,
  };
}

if (!Object.keys(platforms).length) throw new Error('nenhuma plataforma no latest.json');

const out = {
  version: tag,
  notes: 'sightdeck ' + tag,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync('latest.json', JSON.stringify(out, null, 2) + '\n');
console.log('latest.json: ' + Object.keys(platforms).join(', '));
