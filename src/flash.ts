// Kamino Lend flash loans (SOL reserve, main market). Addresses verified on-chain 2026-10-09:
// reserve d4A2… belongs to market 7u3H…, its liquidity mint is wSOL, and its supply/fee vaults
// are owned by the market authority PDA ["lma", market].
import crypto from "node:crypto";
import { PublicKey, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";

export const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
export const KAMINO_MAIN_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
export const KAMINO_SOL_RESERVE = new PublicKey("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q");
export const KAMINO_SOL_SUPPLY = new PublicKey("GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U");
export const KAMINO_SOL_FEE_VAULT = new PublicKey("3JNof8s453bwG5UqiXBLJc77NRQXezYYEBbk3fqnoKph");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const LMA = PublicKey.findProgramAddressSync([Buffer.from("lma"), KAMINO_MAIN_MARKET.toBuffer()], KLEND)[0];

const disc = (name: string) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

export const ata = (owner: PublicKey, mint = WSOL_MINT) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/** create the owner's ATA if it doesn't exist (idempotent) */
export function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint = WSOL_MINT) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM, data: Buffer.from([1]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
  });
}

/** close the wSOL ATA -> all its lamports (wSOL + rent) go back to the owner as native SOL */
export function closeWsolAta(owner: PublicKey) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM, data: Buffer.from([9]),
    keys: [
      { pubkey: ata(owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
  });
}

function flashKeys(user: PublicKey) {
  return [
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: LMA, isSigner: false, isWritable: false },
    { pubkey: KAMINO_MAIN_MARKET, isSigner: false, isWritable: false },
    { pubkey: KAMINO_SOL_RESERVE, isSigner: false, isWritable: true },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: KAMINO_SOL_SUPPLY, isSigner: false, isWritable: true },
    { pubkey: ata(user), isSigner: false, isWritable: true },
    { pubkey: KAMINO_SOL_FEE_VAULT, isSigner: false, isWritable: true },
    { pubkey: KLEND, isSigner: false, isWritable: false }, // referrer_token_state: None
    { pubkey: KLEND, isSigner: false, isWritable: false }, // referrer_account: None
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
  ];
}

export function flashBorrow(user: PublicKey, lamports: bigint) {
  return new TransactionInstruction({ programId: KLEND, keys: flashKeys(user),
    data: Buffer.concat([disc("flash_borrow_reserve_liquidity"), u64(lamports)]) });
}

/** borrowIxIndex = position of the borrow instruction in the transaction */
export function flashRepay(user: PublicKey, lamports: bigint, borrowIxIndex: number) {
  return new TransactionInstruction({ programId: KLEND, keys: flashKeys(user),
    data: Buffer.concat([disc("flash_repay_reserve_liquidity"), u64(lamports), Buffer.from([borrowIxIndex])]) });
}
