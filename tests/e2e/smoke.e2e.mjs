import { browser, $, expect } from '@wdio/globals';

/* Smoke E2E: prova que o binário abre a janela Tauri, serve o frontend real
 * e que o IPC (`invoke`) e o plugin WDIO estão vivos dentro da webview. */
describe('sightdeck (janela Tauri real)', () => {
  it('abre a janela com o chrome principal', async () => {
    await expect($('#log')).toBeExisting();
    await expect($('#input')).toBeExisting();
    await expect($('#send')).toBeExisting();
    await expect($('#tabs')).toBeExisting();
  });

  it('carrega o index.html na webview', async () => {
    expect(await browser.getTitle()).toContain('sightdeck');
    // O Tauri serve o frontend no custom protocol, sem `/index.html` no href.
    const href = await browser.tauri.execute(() => window.location.href);
    expect(String(href)).toBe('tauri://localhost');
  });

  it('expõe o plugin WDIO e chama um comando real pelo IPC', async () => {
    const hasPlugin = await browser.tauri.execute(() => Boolean(window.wdioTauri));
    expect(hasPlugin).toBe(true);
    const version = await browser.tauri.execute(({ core }) => core.invoke('app_version'));
    expect(String(version)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('digita no composer', async () => {
    await $('#input').setValue('teste e2e');
    await expect($('#input')).toHaveValue('teste e2e');
  });

  it('não deixa erro de JS no console da webview', async () => {
    // O coletor vive no bundle E2E (main.js): erro de boot vira falha aqui.
    await browser.pause(1000);
    const errors = await browser.tauri.execute(() => window.__e2eErrors || []);
    expect(errors).toEqual([]);
  });
});
