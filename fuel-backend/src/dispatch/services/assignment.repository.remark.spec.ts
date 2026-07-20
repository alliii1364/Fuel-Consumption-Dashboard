import { AssignmentRepository } from './assignment.repository';

function repo() {
  const ds = { query: jest.fn() };
  return { r: new AssignmentRepository(ds as any), ds };
}

describe('AssignmentRepository.setEventRemark', () => {
  it('returns true when the event belongs to the manager and issues the UPDATE', async () => {
    const { r, ds } = repo();
    ds.query
      .mockResolvedValueOnce([{ '1': 1 }]) // ownership SELECT found the row
      .mockResolvedValueOnce({ affectedRows: 1 }); // UPDATE result

    const ok = await r.setEventRemark(42, 5, 900, 'traffic jam');

    expect(ok).toBe(true);
    expect(ds.query).toHaveBeenCalledTimes(2);
    // ownership scoped by user_id + assignment_id + event_id
    expect(ds.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('a.user_id = ?'),
      expect.arrayContaining([42, 5, 900]),
    );
    // UPDATE issued unconditionally against the located event
    expect(ds.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE fd_route_events'),
      ['traffic jam', 900],
    );
  });

  it('returns false when no row matched (not the managers event) and does not issue the UPDATE', async () => {
    const { r, ds } = repo();
    ds.query.mockResolvedValueOnce([]); // ownership SELECT found nothing

    const ok = await r.setEventRemark(42, 5, 900, 'x');

    expect(ok).toBe(false);
    expect(ds.query).toHaveBeenCalledTimes(1);
  });
});
