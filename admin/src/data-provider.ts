import type { DataProvider, GetListParams, GetListResult, RaRecord } from 'ra-core';
import { adminUsers } from './api.js';

const unsupported = (): Promise<never> =>
  Promise.reject(new Error('Esta operación no está disponible en el panel.'));

export const dataProvider: DataProvider = {
  supportAbortSignal: true,
  getList: async <RecordType extends RaRecord>(
    resource: string,
    params: GetListParams,
  ): Promise<GetListResult<RecordType>> => {
    if (resource !== 'users') return unsupported();
    const filter: unknown = params.filter;
    const email =
      filter !== null && typeof filter === 'object' && 'email' in filter ? filter.email : undefined;
    if (email !== undefined && typeof email !== 'string') return unsupported();
    const { page, perPage } = params.pagination ?? { page: 1, perPage: 25 };
    const result = await adminUsers(
      {
        limit: perPage,
        offset: (page - 1) * perPage,
        ...(email === undefined || email.length === 0 ? {} : { email }),
      },
      params.signal,
    );
    // ra-core's provider interface is generic over the consumer's record type.
    // This single-resource adapter has already parsed the application contract.
    return { data: result.items as unknown as RecordType[], total: result.total };
  },
  getOne: unsupported,
  getMany: unsupported,
  getManyReference: unsupported,
  create: unsupported,
  update: unsupported,
  updateMany: unsupported,
  delete: unsupported,
  deleteMany: unsupported,
};
