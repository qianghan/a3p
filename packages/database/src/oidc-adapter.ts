import { prisma } from './index';

// Satisfies oidc-provider's Adapter interface (see oidc-provider/lib/adapters).
export class PrismaOidcAdapter {
  constructor(private readonly type: string) {}

  async upsert(id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void> {
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    await prisma.oidcModel.upsert({
      where: { type_id: { type: this.type, id } },
      create: {
        id,
        type: this.type,
        payload: payload as any,
        grantId: (payload as any).grantId ?? null,
        userCode: (payload as any).userCode ?? null,
        uid: (payload as any).uid ?? null,
        expiresAt,
      },
      update: {
        payload: payload as any,
        grantId: (payload as any).grantId ?? null,
        userCode: (payload as any).userCode ?? null,
        uid: (payload as any).uid ?? null,
        expiresAt,
      },
    });
  }

  async find(id: string): Promise<Record<string, unknown> | undefined> {
    const row = await prisma.oidcModel.findFirst({
      where: { type: this.type, id, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    return row ? (row.payload as Record<string, unknown>) : undefined;
  }

  async findByUserCode(userCode: string): Promise<Record<string, unknown> | undefined> {
    const row = await prisma.oidcModel.findFirst({ where: { type: this.type, userCode } });
    return row ? (row.payload as Record<string, unknown>) : undefined;
  }

  async findByUid(uid: string): Promise<Record<string, unknown> | undefined> {
    const row = await prisma.oidcModel.findFirst({ where: { type: this.type, uid } });
    return row ? (row.payload as Record<string, unknown>) : undefined;
  }

  async consume(id: string): Promise<void> {
    await prisma.oidcModel.updateMany({
      where: { type: this.type, id },
      data: { payload: { consumed: Math.floor(Date.now() / 1000) } as any },
    });
  }

  async destroy(id: string): Promise<void> {
    await prisma.oidcModel.deleteMany({ where: { type: this.type, id } });
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await prisma.oidcModel.deleteMany({ where: { grantId } });
  }
}
