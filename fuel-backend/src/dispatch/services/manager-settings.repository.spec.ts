import { ManagerSettingsRepository } from './manager-settings.repository';

function repo(rows: any[]) {
  const ds = { query: jest.fn().mockResolvedValue(rows) };
  return { r: new ManagerSettingsRepository(ds as any), ds };
}

describe('ManagerSettingsRepository.getSettings', () => {
  it('defaults requireBinPhoto to true when no row exists', async () => {
    const { r } = repo([]);
    expect(await r.getSettings(1)).toEqual({ requireBinPhoto: true });
  });

  it('maps require_bin_photo=0 to false', async () => {
    const { r } = repo([{ require_bin_photo: 0 }]);
    expect(await r.getSettings(1)).toEqual({ requireBinPhoto: false });
  });

  it('maps require_bin_photo=1 to true', async () => {
    const { r } = repo([{ require_bin_photo: 1 }]);
    expect(await r.getSettings(1)).toEqual({ requireBinPhoto: true });
  });
});
