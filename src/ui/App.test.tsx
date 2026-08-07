import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';

describe('application shell', () => {
  beforeEach(async () => { await new Promise<void>((resolve) => { const request = indexedDB.deleteDatabase('relayless-local-vault'); request.onsuccess = () => resolve(); request.onerror = () => resolve(); request.onblocked = () => resolve(); }); });
  it('renders a simple bilingual first-launch screen', async () => {
    render(<App/>);
    expect(await screen.findByRole('heading', { name: 'Начать пользоваться' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'EN' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Продолжить' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Открыть без сохранения' })).toBeTruthy();
  });

  it('routes a new user through chats, contacts, and account setup', async () => {
    render(<App/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть без сохранения' }));
    expect(await screen.findByPlaceholderText('Поиск по чатам и сообщениям')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Контакты' }));
    expect(await screen.findByRole('heading', { name: 'Добавить контакт' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Подключить аккаунт' }));
    expect(await screen.findByRole('heading', { name: 'Подключить XMPP' })).toBeTruthy();
  });
});
