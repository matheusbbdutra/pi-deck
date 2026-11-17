# Release — sightdeck

Procedimento de release e de gestão das chaves de assinatura. Escrito para ser
seguido sem depender de memória.

## 1. Fluxo atual (sem assinatura)

O app **não** tem auto-update. O que existe é uma checagem manual: `⚙ → Verificar
atualização` consulta `https://api.github.com/repos/matheusbbdutra/sightdeck/releases/latest`
e compara a tag com a versão embutida (`checkUpdate` em `ui/src/main.js`). Se houver
versão maior, mostra "atualização disponível" com link para a release.

Consequência prática: **não há chave de atualização para perder hoje**. Também não há
assinatura de artefato — `.deb` não é verificado pelo dpkg, e o `msi`/`exe` do Windows
sai sem Authenticode.

### Passo a passo

1. Bump da versão nos três lugares (eles precisam bater):
   ```bash
   npm version <x.y.z> --no-git-tag-version
   sed -i 's/^version = ".*"/version = "<x.y.z>"/' src-tauri/Cargo.toml
   sed -i 's/"version": ".*"/"version": "<x.y.z>"/' src-tauri/tauri.conf.json
   ```
2. Atualizar `CHANGELOG.md` (entrada nova; `Added` / `Changed` / `Fixed` / `Renamed`).
3. Rodar a suíte inteira **antes** de taggear:
   ```bash
   npm run test:ui && (cd src-tauri && cargo test) && npm run build
   ```
   **Nunca** instale a partir de `cargo build --release`: sem `--features tauri/custom-protocol`
   o build vira `dev = true` (`tauri/build.rs`), os assets não são embutidos e a webview tenta
   `devUrl` (`localhost:1420`) — o app abre com "Could not connect to localhost". Use `tauri build`
   (ou o `.deb`), que passa a feature.
4. Commit, tag anotada e push dos dois:
   ```bash
   git commit -am "release: <x.y.z>"
   git tag -a v<x.y.z> -m "sightdeck <x.y.z>" && git push origin main v<x.y.z>
   ```
5. O workflow `release` (`.github/workflows/release.yml`) roda `test`, `test-windows`,
   `clippy` e `build` (deb/rpm/AppImage, msi/nsis), cria uma release **draft** e anexa
   os assets. Acompanhar:
   ```bash
   gh run list --limit 3
   gh release view v<x.y.z>          # deve estar draft com os assets
   ```
6. Publicar:
   ```bash
   gh release edit v<x.y.z> --draft=false --latest
   ```

### Nota de migração

Quando o **nome do pacote** muda (foi o caso de `pi-deck` → `sightdeck` na 0.2.0),
quem tem a versão anterior **não** recebe update: é preciso instalar o `.deb` novo e
remover o antigo. Além disso o `localStorage` do webview é chaveado pelo
`identifier` do Tauri (`dev.matheus.sightdeck`), então abas/ajustes/zoom não migram.

## 2. Assinatura de atualização (Tauri updater / minisign)

Só é necessária **se adotarmos auto-update** (`tauri-plugin-updater`). Enquanto o
plugin não existir, esta seção é preparação.

### Chaves

```bash
mkdir -p ~/.tauri
npx tauri signer generate -w ~/.tauri/sightdeck.key
```

> **Cuidado com o `npm run`**: `npm run tauri signer generate -w ~/…` **falha**, porque o npm
> consome o `-w` como `--workspace` (`npm error No workspaces found`). Use `npx tauri …`
> ou separe os argumentos: `npm run tauri -- signer generate -w ~/…`.
>
> Para automação: `--ci` evita prompts e `-p "<senha>"` define a senha. Testado:
> gera dois arquivos (~348 B a privada, ~152 B a pública).

Gera um par **minisign**:
- **privada**: `~/.tauri/sightdeck.key` (com senha).
- **pública**: `~/.tauri/sightdeck.key.pub` — vai para `tauri.conf.json` em
  `plugins.updater.pubkey` (é público, pode ser commitado).

No CI, dois secrets:
- `TAURI_SIGNING_PRIVATE_KEY` — **conteúdo** do arquivo da chave.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — a senha.

E no config: `bundle.createUpdaterArtifacts: true`.

### Onde guardar (fonte de verdade = Bitwarden)

GitHub Secrets são *write-only*: não dá para lê-los de volta, então **nunca** são backup.

1. Bitwarden → item tipo **Secure Note** (`sightdeck — Tauri updater key`):
   - campo de texto: conteúdo integral da chave privada;
   - campo oculto: a senha da chave;
   - notas: chave pública, fingerprint e a data de criação.
2. **Cópia offline** (papel em local seguro ou USB), porque cofre único é ponto único
   de falha. Ativar 2FA e *emergency access* na conta.
3. Registrar no item **o que quebra se a chave vazar**: qualquer um assina updates que
   todos os clientes aceitam → revogar = gerar par novo + reinstalação nos clientes.

### Custo de perder a chave

É possível gerar um par novo e trocar o `pubkey`, mas **clientes com a chave antiga
recusam releases novas** — o usuário precisa reinstalar manualmente. Por isso o
backup duplo (cofre + offline).

### Rotação (se precisar)

1. Gerar par novo e atualizar `plugins.updater.pubkey`.
2. Guardar o par novo no Bitwarden e na cópia offline; marcar o antigo como revogado.
3. Publicar uma release com nota explícita de **reinstalação necessária**.

## 3. Assinatura de pacote (opcional, independente do updater)

- **apt**: assinar o índice do repositório com GPG (`gpg --detach-sign` no `Release`);
  guardar a chave privada no Bitwarden + offline. O `.deb` em si não é assinado.
- **rpm**: `rpm --addsign` com chave GPG; publicar a pública.
- **Windows**: Authenticode exige certificado (pago); sem ele o SmartScreen avisa.

Nenhum dos três está implementado hoje; o README declara os binários como **unsigned**.

## 4. Verificação pós-release

```bash
dpkg -i sightdeck_<x.y.z>_amd64.deb && sightdeck --version   # versão instalada
sha256sum sightdeck_<x.y.z>_amd64.deb                        # conferir com o asset publicado
gh release view v<x.y.z> --json assets --jq '.assets[].name' # 5 assets esperados (sem updater; com updater, +2)
```
