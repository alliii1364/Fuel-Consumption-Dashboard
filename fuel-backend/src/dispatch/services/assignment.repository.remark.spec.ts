import { AssignmentRepository } from './assignment.repository';

function repo(updateResult: any) {
  const ds = { query: jest.fn().mockResolvedValue(updateResult) };
  return { r: new AssignmentRepository(ds as any), ds };
}

describe('AssignmentRepository.setEventRemark', () => {
  it('returns true when a row was updated (event belongs to the manager)', async () => {
    const { r, ds } = repo({ affectedRows: 1 });
    const ok = await r.setEventRemark(42, 5, 900, 'traffic jam');
    expect(ok).toBe(true);
    // scoped by user_id + assignment_id + event_id
    expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('a.user_id = ?'), expect.arrayContaining([42, 5, 900]));
  });

  it('returns false when no row matched (not the managers event)', async () => {
    const { r } = repo({ affectedRows: 0 });
    expect(await r.setEventRemark(42, 5, 900, 'x')).toBe(false);
  });
});
