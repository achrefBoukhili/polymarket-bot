import fs from 'fs';
import YAML from 'yaml';
import { AppConfig, RiskLimits, TradingMode } from '../types';
import { listStrategies } from '../strategies/registry';

interface RawRiskLimits {
  max_position_size?: number;
  max_exposure_per_market?: number;
  max_daily_loss?: number;
  max_open_trades?: number;
  max_drawdown?: number;
}

interface RawConfig {
  environment?: { enable_live_trading?: boolean };
  wallets?: Array<{
    id: string;
    mode?: TradingMode;
    strategy: string;
    capital?: number;
    risk_limits?: RawRiskLimits;
  }>;
  strategy_config?: Record<string, Record<string, unknown>>;
  polymarket?: { gamma_api?: string; clob_api?: string };
}

const DEFAULT_LIMITS: RiskLimits = {
  maxPositionSize: 100,
  maxExposurePerMarket: 200,
  maxDailyLoss: 100,
  maxOpenTrades: 5,
  maxDrawdown: 0.2,
};

export function loadConfig(path: string): AppConfig {
  const raw = fs.readFileSync(path, 'utf8');
  const parsed = YAML.parse(raw) as RawConfig;

  const wallets = (parsed.wallets ?? []).map((wallet) => ({
    id: wallet.id,
    mode: wallet.mode ?? 'PAPER',
    strategy: wallet.strategy,
    capital: wallet.capital ?? 0,
    riskLimits: {
      ...DEFAULT_LIMITS,
      ...toRiskLimits(wallet.risk_limits),
    },
  }));

  validateWallets(wallets);

  const liveRequested = Boolean(parsed.environment?.enable_live_trading ?? false);
  const liveEnvEnabled = process.env.ENABLE_LIVE_TRADING === 'true';

  return {
    environment: {
      enableLiveTrading: liveRequested && liveEnvEnabled,
    },
    wallets,
    strategyConfig: parsed.strategy_config ?? {},
    polymarket: {
      gammaApi: parsed.polymarket?.gamma_api ?? 'https://gamma-api.polymarket.com',
      clobApi: parsed.polymarket?.clob_api ?? 'https://clob.polymarket.com',
    },
  };
}

/**
 * Fail at load rather than at 3am.
 *
 * Every one of these used to pass silently and then misbehave much later:
 * a wallet with no capital registers and rejects every order on balance; an
 * unknown strategy is logged once at engine init and the wallet simply never
 * trades; duplicate ids throw deep inside WalletManager.
 */
function validateWallets(
  wallets: Array<{ id: string; mode: TradingMode; strategy: string; capital: number; riskLimits: RiskLimits }>,
): void {
  const problems: string[] = [];
  const known = listStrategies();
  const seen = new Set<string>();

  for (const w of wallets) {
    const where = `wallet "${w.id ?? '(missing id)'}"`;

    if (!w.id) problems.push('a wallet has no id');
    else if (seen.has(w.id)) problems.push(`${where}: duplicate id`);
    else seen.add(w.id);

    if (!w.strategy) problems.push(`${where}: no strategy`);
    else if (!known.includes(w.strategy)) {
      problems.push(`${where}: unknown strategy "${w.strategy}" (available: ${known.join(', ')})`);
    }

    if (w.mode !== 'LIVE' && w.mode !== 'PAPER') problems.push(`${where}: mode must be LIVE or PAPER, got "${w.mode}"`);
    if (!(w.capital > 0)) problems.push(`${where}: capital must be > 0, got ${w.capital}`);

    const r = w.riskLimits;
    if (!(r.maxPositionSize > 0)) problems.push(`${where}: max_position_size must be > 0`);
    if (!(r.maxExposurePerMarket > 0)) problems.push(`${where}: max_exposure_per_market must be > 0`);
    if (!(r.maxDailyLoss > 0)) problems.push(`${where}: max_daily_loss must be > 0`);
    if (!(r.maxOpenTrades > 0)) problems.push(`${where}: max_open_trades must be > 0`);
    if (!(r.maxDrawdown > 0 && r.maxDrawdown <= 1)) {
      problems.push(`${where}: max_drawdown must be a fraction in (0, 1], got ${r.maxDrawdown}`);
    }
    if (r.maxExposurePerMarket < r.maxPositionSize) {
      problems.push(
        `${where}: max_exposure_per_market (${r.maxExposurePerMarket}) is below max_position_size (${r.maxPositionSize}) — no single order can ever pass both`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid config:\n  - ${problems.join('\n  - ')}`);
  }
}

function toRiskLimits(risk?: RawRiskLimits): Partial<RiskLimits> {
  if (!risk) return {};
  return {
    maxPositionSize: risk.max_position_size,
    maxExposurePerMarket: risk.max_exposure_per_market,
    maxDailyLoss: risk.max_daily_loss,
    maxOpenTrades: risk.max_open_trades,
    maxDrawdown: risk.max_drawdown,
  };
}
