/**
 * Shared KernelAccountFactory singleton.
 *
 * Ensures account/client caches persist across requests instead of
 * being discarded when each controller handler creates a new instance.
 */
import { prisma } from '../../lib/prisma';
import { KernelAccountFactory } from './account-factory.service.js';
import { TurnkeyEVMSignerService } from '../turnkey/evm-signer.service.js';

let _instance: KernelAccountFactory | null = null;

export function getKernelAccountFactory(): KernelAccountFactory {
  if (!_instance) {
    const evmSigner = new TurnkeyEVMSignerService(prisma);
    _instance = new KernelAccountFactory(prisma, evmSigner);
  }
  return _instance;
}
