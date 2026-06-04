"""
A 股量化筛选脚本。

依赖:
  pip install akshare pandas requests tqdm

示例:
  python scripts/a_share_quant_filter.py --provider ashare --output artifacts/a_share_filter.csv
  python scripts/a_share_quant_filter.py --provider zhitu --zhitu-token 你的token --output artifacts/a_share_filter.csv

策略条件:
  0. 股票池只保留沪深主板，排除创业板、科创板、北交所和 ST/退市股票。
  1. 使用当天最新日 K 判断：近 12 日平均成交量 > 近 50 日平均成交量。
  2. 最近 5 次满足条件 1 的历史信号中，按信号日收盘价买入后，
     后续 2 个交易日内最高价涨幅 > 5% 的成功次数 > 4。
  3. 默认只保留量能倍数 >= 1.5，且只保留最新交易日信号。

数据源:
  股票池：akshare / 东方财富。
  provider=ashare：mpquant/Ashare。
  provider=zhitu：智兔 API。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import dataclasses
import datetime as dt
import io
import importlib
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterable

pd: Any = None

ZHITU_BASE_URL = "https://api.zhituapi.com"


@dataclasses.dataclass(frozen=True)
class StrategyConfig:
    short_volume_window: int = 12
    long_volume_window: int = 50
    recent_signal_count: int = 5
    forward_days: int = 2
    profit_threshold: float = 0.05
    history_days: int = 420
    zhitu_adjust: str = "f"


@dataclasses.dataclass(frozen=True)
class StockResult:
    code: str
    name: str
    signal_date: str
    close: float
    avg_volume_12: float
    avg_volume_50: float
    volume_ratio: float
    success_count: int
    recent_signal_dates: str
    recent_signal_returns: str


@dataclasses.dataclass(frozen=True)
class MarketClient:
    provider: str
    akshare: Any
    requests: Any
    ashare_get_price: Any | None = None
    zhitu_token: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="筛选满足策略条件的中国 A 股股票。")
    parser.add_argument("--provider", default="ashare", choices=["ashare", "zhitu"], help="行情数据源：ashare 或 zhitu。")
    parser.add_argument("--zhitu-token", default="", help="智兔 API token；为空时读取环境变量或 .env 中的 ZHITU_TOKEN。")
    parser.add_argument("--zhitu-adjust", default="f", choices=["n", "f", "b", "fr", "br"], help="智兔复权方式：n 不复权，f 前复权，b 后复权。")
    parser.add_argument("--output", default="artifacts/a_share_quant_filter.csv", help="结果 CSV 输出路径。")
    parser.add_argument("--workers", type=int, default=4, help="并发拉取股票行情的线程数。")
    parser.add_argument("--sleep", type=float, default=0.05, help="每只股票请求后的休眠秒数，避免数据源限流。")
    parser.add_argument("--history-days", type=int, default=420, help="向前拉取的自然日数量。")
    parser.add_argument("--min-volume-ratio", type=float, default=1.5, help="近 12 日均量 / 近 50 日均量阈值，默认 1.5。")
    parser.add_argument("--keep-non-latest", action="store_true", help="保留非最新交易日信号。默认只保留最新交易日。")
    parser.add_argument("--retries", type=int, default=3, help="接口请求失败后的重试次数。")
    parser.add_argument("--progress-interval", type=int, default=50, help="每完成多少只股票输出一次进度。")
    return parser.parse_args()


def log(message: str) -> None:
    print(message, flush=True)


def read_dotenv_value(key: str, env_path: str = ".env") -> str:
    path = Path(env_path)
    if not path.exists():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        if name.strip() == key:
            return value.strip().strip('"').strip("'")
    return ""


def import_required(package_names: list[str]) -> dict[str, Any]:
    modules: dict[str, Any] = {}
    missing: list[str] = []
    for package in package_names:
        try:
            modules[package] = importlib.import_module(package)
        except ImportError:
            missing.append(package)

    if missing:
        install_command = f'"{sys.executable}" -m pip install akshare pandas requests tqdm'
        raise SystemExit(
            "当前 python 环境缺少依赖: "
            + ", ".join(missing)
            + "\n当前 python: "
            + sys.executable
            + "\n请使用同一个 python 安装依赖:\n  "
            + install_command
        )
    return modules


def import_ashare_get_price():
    try:
        return importlib.import_module("Ashare").get_price
    except ImportError:
        pass

    # mpquant/Ashare 不是标准 pip 包；缺少本地模块时从官方单文件源码加载。
    import requests

    url = "https://raw.githubusercontent.com/mpquant/Ashare/master/Ashare.py"
    response = requests.get(url, timeout=20)
    response.raise_for_status()
    namespace: dict[str, Any] = {}
    exec(compile(response.text, "Ashare.py", "exec"), namespace)
    return namespace["get_price"]


def load_market_client(provider: str, zhitu_token: str) -> MarketClient:
    modules = import_required(["akshare", "pandas", "requests"])
    global pd
    pd = modules["pandas"]

    if provider == "ashare":
        return MarketClient(
            provider="ashare",
            akshare=modules["akshare"],
            requests=modules["requests"],
            ashare_get_price=import_ashare_get_price(),
        )

    token = zhitu_token or os.getenv("ZHITU_TOKEN", "") or read_dotenv_value("ZHITU_TOKEN")
    if not token:
        raise SystemExit("缺少智兔 token。请在 .env 中添加 ZHITU_TOKEN=你的token，或运行时传入 --zhitu-token。")
    return MarketClient(provider="zhitu", akshare=modules["akshare"], requests=modules["requests"], zhitu_token=token)


def is_main_board_code(code: str) -> bool:
    return code.startswith(("60", "00"))


def is_non_st_name(name: str) -> bool:
    normalized = name.upper().replace(" ", "")
    return "ST" not in normalized and "退" not in name


def normalize_stock_list(raw: pd.DataFrame) -> pd.DataFrame:
    code_col = "代码" if "代码" in raw.columns else "code"
    name_col = "名称" if "名称" in raw.columns else "name"
    stocks = raw[[code_col, name_col]].rename(columns={code_col: "code", name_col: "name"}).copy()
    stocks["code"] = stocks["code"].astype(str).str.extract(r"(\d{6})", expand=False)
    stocks["name"] = stocks["name"].astype(str)
    stocks = stocks.dropna(subset=["code"]).drop_duplicates("code")

    mask = stocks["code"].map(is_main_board_code) & stocks["name"].map(is_non_st_name)
    return stocks[mask].sort_values("code").reset_index(drop=True)


def retry_call(label: str, attempts: int, func):
    last_error: Exception | None = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            return func()
        except Exception as exc:
            last_error = exc
            log(f"{label} 失败 {attempt}/{max(1, attempts)}: {exc}")
            time.sleep(min(3, attempt))
    raise RuntimeError(f"{label} 多次失败: {last_error}") from last_error


def fetch_stock_list(client: MarketClient, retries: int) -> pd.DataFrame:
    log("[股票池] 正在从东方财富获取 A 股列表...")

    def request():
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return client.akshare.stock_info_a_code_name()

    raw = retry_call("[股票池] 东方财富股票列表", retries, request)
    stocks = normalize_stock_list(raw)
    log(f"[股票池] 已过滤为沪深主板非 ST 股票: {len(stocks)} 只")
    return stocks


def market_code(code: str, dot_suffix: bool) -> str:
    suffix = "SH" if code.startswith("6") else "SZ"
    return f"{code}.{suffix}" if dot_suffix else f"{suffix.lower()}{code}"


def normalize_daily_frame(df: pd.DataFrame, code: str) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(column).strip() for column in df.columns]
    if "" in df.columns and "日期" not in df.columns:
        df = df.rename(columns={"": "日期"})
    if "日期" not in df.columns and "date" not in df.columns and "time" not in df.columns:
        index_name = df.index.name or "日期"
        df = df.reset_index().rename(columns={index_name: "日期", "index": "日期"})
        df.columns = [str(column).strip() for column in df.columns]
        if "" in df.columns and "日期" not in df.columns:
            df = df.rename(columns={"": "日期"})

    rename_map = {
        "date": "日期",
        "time": "日期",
        "day": "日期",
        "datetime": "日期",
        "trade_date": "日期",
        "close": "收盘",
        "price": "收盘",
        "now": "收盘",
        "last": "收盘",
        "high": "最高",
        "volume": "成交量",
        "vol": "成交量",
    }
    data = df.rename(columns={key: value for key, value in rename_map.items() if key in df.columns}).copy()
    required = ["日期", "收盘", "最高", "成交量"]
    missing = [column for column in required if column not in data.columns]
    if missing:
        raise ValueError(f"{code} 缺少字段: {missing}; columns={list(df.columns)}")

    data = data[required].copy()
    data["日期"] = pd.to_datetime(data["日期"]).dt.normalize()
    for column in ["收盘", "最高", "成交量"]:
        data[column] = pd.to_numeric(data[column], errors="coerce")
    return data.dropna(subset=required).sort_values("日期").reset_index(drop=True)


def flatten_records(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []
    for key in ["data", "list", "items", "rows", "kline", "klines"]:
        records = flatten_records(value.get(key))
        if records:
            return records
    if any(key in value for key in ["close", "price", "high", "volume", "vol"]):
        return [value]
    return []


def fetch_ashare_daily(client: MarketClient, code: str, history_days: int, retries: int) -> pd.DataFrame:
    assert client.ashare_get_price is not None
    symbol = market_code(code, dot_suffix=False)

    def request():
        return client.ashare_get_price(symbol, frequency="1d", count=max(history_days, 80))

    df = retry_call(f"[Ashare] {code}", retries, request)
    return normalize_daily_frame(df if isinstance(df, pd.DataFrame) else pd.DataFrame(df), code)


def zhitu_get(client: MarketClient, path: str, params: dict[str, str], retries: int) -> Any:
    def request():
        response = client.requests.get(f"{ZHITU_BASE_URL}{path}", params=params, timeout=20)
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, dict) and str(payload.get("code", "0")) not in ("0", "200"):
            raise RuntimeError(payload.get("message") or payload)
        return payload.get("data", payload) if isinstance(payload, dict) else payload

    return retry_call(f"[智兔] {path}", retries, request)


def fetch_zhitu_daily(client: MarketClient, code: str, config: StrategyConfig, retries: int) -> pd.DataFrame:
    symbol = market_code(code, dot_suffix=True)
    end = dt.date.today().strftime("%Y-%m-%d")
    start = (dt.date.today() - dt.timedelta(days=config.history_days)).strftime("%Y-%m-%d")
    history = zhitu_get(
        client,
        f"/hs/history/{symbol}/d/{config.zhitu_adjust}",
        {"token": client.zhitu_token, "st": start, "et": end},
        retries,
    )
    latest = zhitu_get(
        client,
        f"/hs/latest/{symbol}/d/{config.zhitu_adjust}",
        {"token": client.zhitu_token, "limit": "1"},
        retries,
    )
    df = normalize_daily_frame(pd.DataFrame(flatten_records(history)), code)
    latest_df = normalize_daily_frame(pd.DataFrame(flatten_records(latest)), code)
    if not latest_df.empty:
        df = df[df["日期"] != latest_df.iloc[-1]["日期"]]
        df = pd.concat([df, latest_df.tail(1)], ignore_index=True)
    return df.sort_values("日期").reset_index(drop=True)


def fetch_daily_history(client: MarketClient, code: str, config: StrategyConfig, retries: int) -> pd.DataFrame:
    if client.provider == "ashare":
        return fetch_ashare_daily(client, code, config.history_days, retries)
    return fetch_zhitu_daily(client, code, config, retries)


def add_volume_signal(df: pd.DataFrame, config: StrategyConfig) -> pd.DataFrame:
    data = df.copy()
    data["avg_volume_12"] = data["成交量"].rolling(config.short_volume_window).mean()
    data["avg_volume_50"] = data["成交量"].rolling(config.long_volume_window).mean()
    data["volume_signal"] = data["avg_volume_12"] > data["avg_volume_50"]
    return data


def forward_max_return(data: pd.DataFrame, signal_index: int, config: StrategyConfig) -> float | None:
    start = signal_index + 1
    end = signal_index + config.forward_days + 1
    future = data.iloc[start:end]
    if len(future) < config.forward_days:
        return None
    buy_close = float(data.iloc[signal_index]["收盘"])
    if buy_close <= 0:
        return None
    return float(future["最高"].max() / buy_close - 1)


def evaluate_stock(
    client: MarketClient,
    code: str,
    name: str,
    config: StrategyConfig,
    retries: int,
    sleep_seconds: float,
    min_volume_ratio: float,
) -> StockResult | None:
    try:
        data = add_volume_signal(fetch_daily_history(client, code, config, retries), config)
        time.sleep(sleep_seconds)
        min_rows = config.long_volume_window + config.forward_days + config.recent_signal_count
        if len(data) < min_rows:
            return None

        latest = data.iloc[-1]
        if not bool(latest["volume_signal"]):
            return None
        volume_ratio = float(latest["avg_volume_12"] / latest["avg_volume_50"])
        if volume_ratio < min_volume_ratio:
            return None

        eligible = data.iloc[: -config.forward_days].copy()
        signal_indices = eligible.index[eligible["volume_signal"]].tolist()[-config.recent_signal_count :]
        if len(signal_indices) < config.recent_signal_count:
            return None

        returns: list[float] = []
        for signal_index in signal_indices:
            value = forward_max_return(data, signal_index, config)
            if value is None:
                return None
            returns.append(value)

        success_count = sum(value > config.profit_threshold for value in returns)
        if success_count <= 4:
            return None

        return StockResult(
            code=code,
            name=name,
            signal_date=latest["日期"].strftime("%Y-%m-%d"),
            close=float(latest["收盘"]),
            avg_volume_12=float(latest["avg_volume_12"]),
            avg_volume_50=float(latest["avg_volume_50"]),
            volume_ratio=volume_ratio,
            success_count=success_count,
            recent_signal_dates=",".join(data.loc[signal_indices, "日期"].dt.strftime("%Y-%m-%d")),
            recent_signal_returns=",".join(f"{value:.2%}" for value in returns),
        )
    except Exception as exc:
        log(f"[跳过] {code} {name}: {exc}")
        return None


def iter_results(
    client: MarketClient,
    stocks: pd.DataFrame,
    config: StrategyConfig,
    workers: int,
    retries: int,
    sleep_seconds: float,
    progress_interval: int,
    min_volume_ratio: float,
) -> Iterable[StockResult]:
    total = len(stocks)
    completed = 0
    hits = 0
    interval = max(1, progress_interval)
    started_at = time.time()

    log(f"[筛选] 开始并发筛选，共 {total} 只股票，线程数: {max(1, workers)}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [
            executor.submit(evaluate_stock, client, row.code, row.name, config, retries, sleep_seconds, min_volume_ratio)
            for row in stocks.itertuples(index=False)
        ]
        log(f"[筛选] 已提交 {len(futures)} 个股票任务，开始等待结果...")
        for future in concurrent.futures.as_completed(futures):
            completed += 1
            result = future.result()
            if result:
                hits += 1
                yield result
            if completed % interval == 0 or completed == total:
                elapsed = max(0.001, time.time() - started_at)
                speed = completed / elapsed
                log(f"[筛选] 进度 {completed}/{total}，命中 {hits}，速度 {speed:.1f} 只/秒")


def save_results(results: list[StockResult], output: str, keep_non_latest: bool) -> None:
    path = Path(output)
    log(f"[输出] 正在保存结果到 {path}...")
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(dataclasses.asdict(item) for item in results)
    if not df.empty:
        if not keep_non_latest:
            latest_signal_date = df["signal_date"].max()
            before_count = len(df)
            df = df[df["signal_date"] == latest_signal_date].copy()
            log(f"[过滤] 只保留最新交易日 {latest_signal_date} 信号: {before_count} -> {len(df)}")
        df = df.sort_values(["success_count", "volume_ratio", "avg_volume_12"], ascending=[False, False, False])
    df.to_csv(path, index=False, encoding="utf-8-sig")
    log(f"[完成] 筛选完成，共 {len(df)} 只股票满足条件，结果已保存: {path}")


def main() -> None:
    args = parse_args()
    config = StrategyConfig(history_days=args.history_days, zhitu_adjust=args.zhitu_adjust)
    client = load_market_client(args.provider, args.zhitu_token)
    stocks = fetch_stock_list(client, args.retries)
    log(f"[配置] 行情 provider: {client.provider}，股票池: 东方财富，待筛选股票数: {len(stocks)}")
    log(f"[配置] 量能倍数阈值: {args.min_volume_ratio}，仅最新交易日: {not args.keep_non_latest}")
    results = list(
        iter_results(
            client,
            stocks,
            config,
            args.workers,
            args.retries,
            args.sleep,
            args.progress_interval,
            args.min_volume_ratio,
        )
    )
    save_results(results, args.output, args.keep_non_latest)


if __name__ == "__main__":
    main()
