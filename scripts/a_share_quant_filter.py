"""
A 股量化筛选脚本。

依赖:
  pip install akshare pandas requests tqdm

示例:
  python scripts/a_share_quant_filter.py --fxyz-token 你的token --output artifacts/a_share_filter.csv

策略条件:
  0. 股票池只保留沪深主板，排除创业板、科创板、北交所和 ST/退市股票。
  1. 使用当天实时行情判断：近 12 日平均成交量 > 近 50 日平均成交量。
  2. 最近 5 次满足条件 1 的历史信号中，按信号日收盘价买入后，
     后续 2 个交易日内最高价涨幅 > 5% 的成功次数 > 4。

数据源:
  股票池：akshare / 东方财富。
  历史 K：api.fxyz.site /wolf/time/kline。
  实时行情：api.fxyz.site /wolf/time。
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

FXYZ_BASE_URL = "http://api.fxyz.site"


@dataclasses.dataclass(frozen=True)
class StrategyConfig:
    short_volume_window: int = 12
    long_volume_window: int = 50
    recent_signal_count: int = 5
    forward_days: int = 2
    profit_threshold: float = 0.05
    history_days: int = 420
    cq: str = "1"
    period: str = "1d"


@dataclasses.dataclass(frozen=True)
class StockResult:
    code: str
    name: str
    signal_date: str
    close: float
    avg_volume_12: float
    avg_volume_50: float
    success_count: int
    recent_signal_dates: str
    recent_signal_returns: str


@dataclasses.dataclass(frozen=True)
class MarketClient:
    akshare: Any
    requests: Any
    token: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="筛选满足策略条件的中国 A 股股票。")
    parser.add_argument("--fxyz-token", default="", help="fxyz token；为空时读取环境变量或 .env 中的 FXYZ_TOKEN。")
    parser.add_argument("--output", default="artifacts/a_share_quant_filter.csv", help="结果 CSV 输出路径。")
    parser.add_argument("--workers", type=int, default=4, help="并发拉取股票行情的线程数。")
    parser.add_argument("--sleep", type=float, default=0.05, help="每只股票请求后的休眠秒数，避免数据源限流。")
    parser.add_argument("--history-days", type=int, default=420, help="向前拉取的自然日数量。")
    parser.add_argument("--period", default="1d", help="fxyz 历史 K 周期，默认 1d。")
    parser.add_argument("--cq", default="1", help="fxyz 历史 K 复权参数，默认 1。")
    parser.add_argument("--retries", type=int, default=3, help="接口请求失败后的重试次数。")
    parser.add_argument("--progress-interval", type=int, default=50, help="每完成多少只股票输出一次进度。")
    return parser.parse_args()


def log(message: str) -> None:
    """立即输出进度，避免长时间请求时控制台看起来没有响应。"""
    print(message, flush=True)


def read_dotenv_value(key: str, env_path: str = ".env") -> str:
    """读取简单 .env 键值，避免额外引入 python-dotenv。"""
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


def load_market_client(fxyz_token: str) -> MarketClient:
    """加载东方财富股票池依赖和 fxyz 行情接口依赖。"""
    modules = import_required(["akshare", "pandas", "requests"])
    global pd
    pd = modules["pandas"]

    token = fxyz_token or os.getenv("FXYZ_TOKEN", "") or read_dotenv_value("FXYZ_TOKEN")
    if not token:
        raise SystemExit("缺少 fxyz token。请在 .env 中添加 FXYZ_TOKEN=你的token，或运行时传入 --fxyz-token。")

    return MarketClient(akshare=modules["akshare"], requests=modules["requests"], token=token)


def is_main_board_code(code: str) -> bool:
    """沪深主板代码：上证 60 开头、深证 00 开头；排除 30/68/8/4 等板块。"""
    return code.startswith(("60", "00"))


def is_non_st_name(name: str) -> bool:
    """排除 ST、*ST、SST 以及名称里带退市标记的股票。"""
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
    """对网络请求做有限重试。"""
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
    """股票池依旧使用东方财富，只做静态过滤，不参与历史/实时行情。"""
    log("[股票池] 正在从东方财富获取 A 股列表...")

    def request():
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return client.akshare.stock_info_a_code_name()

    raw = retry_call("[股票池] 东方财富股票列表", retries, request)
    stocks = normalize_stock_list(raw)
    log(f"[股票池] 已过滤为沪深主板非 ST 股票: {len(stocks)} 只")
    return stocks


def history_start_date(history_days: int) -> str:
    return (dt.date.today() - dt.timedelta(days=history_days)).strftime("%Y-%m-%d")


def fxyz_get(client: MarketClient, path: str, params: dict[str, str], retries: int) -> Any:
    """调用 fxyz 接口并统一处理 code/message/data。"""

    def request():
        response = client.requests.get(f"{FXYZ_BASE_URL}{path}", params=params, timeout=20)
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, dict) and payload.get("code") not in (None, 0, "0", 200, "200"):
            raise RuntimeError(f"{payload.get('message') or payload}")
        return payload.get("data", payload) if isinstance(payload, dict) else payload

    return retry_call(f"[fxyz] {path} {params.get('code', '')}", retries, request)


def first_present(record: dict[str, Any], names: list[str]) -> Any:
    for name in names:
        if name in record and record[name] not in (None, ""):
            return record[name]
    return None


def flatten_records(value: Any) -> list[dict[str, Any]]:
    """兼容 data/list/items/kline 嵌套结构，提取记录列表。"""
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []

    for key in ["list", "items", "rows", "data", "kline", "klines", "values"]:
        child = value.get(key)
        records = flatten_records(child)
        if records:
            return records

    # 实时接口常见返回是单个 dict。
    if any(key in value for key in ["close", "price", "最新价", "成交量", "volume", "vol"]):
        return [value]
    return []


def parse_date_value(value: Any) -> pd.Timestamp:
    if value in (None, ""):
        return pd.Timestamp.today().normalize()
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
        number = int(value)
        unit = "ms" if number > 10_000_000_000 else "s"
        return pd.to_datetime(number, unit=unit).normalize()
    return pd.to_datetime(value).normalize()


def normalize_kline_records(records: list[dict[str, Any]], code: str, realtime: bool = False) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for record in records:
        close = first_present(record, ["close", "收盘", "c", "price", "最新价", "last", "now"])
        high = first_present(record, ["high", "最高", "h"])
        volume = first_present(record, ["volume", "成交量", "vol", "v"])
        date_value = first_present(record, ["date", "日期", "time", "timestamp", "day", "trade_date", "datetime"])

        # 实时快照如果没有 high，则用当前价作为最高价兜底；成交量必须存在，否则无法判断均量。
        if realtime and high in (None, ""):
            high = close
        if close in (None, "") or high in (None, "") or volume in (None, ""):
            continue

        rows.append(
            {
                "日期": parse_date_value(date_value),
                "收盘": close,
                "最高": high,
                "成交量": volume,
            }
        )

    if not rows:
        raise ValueError(f"{code} 没有可解析的 K 线数据")

    df = pd.DataFrame(rows)
    for column in ["收盘", "最高", "成交量"]:
        df[column] = pd.to_numeric(df[column], errors="coerce")
    return df.dropna(subset=["日期", "收盘", "最高", "成交量"]).sort_values("日期").reset_index(drop=True)


def fetch_daily_history(client: MarketClient, code: str, config: StrategyConfig, retries: int) -> pd.DataFrame:
    data = fxyz_get(
        client,
        "/wolf/time/kline",
        {
            "symbol": "stock",
            "code": code,
            "period": config.period,
            "cq": config.cq,
            "startDate": history_start_date(config.history_days),
            "endDate": "2050-01-01",
            "token": client.token,
        },
        retries,
    )
    return normalize_kline_records(flatten_records(data), code)


def fetch_realtime_row(client: MarketClient, code: str, retries: int) -> pd.Series:
    data = fxyz_get(
        client,
        "/wolf/time",
        {"symbol": "stock", "code": code, "token": client.token},
        retries,
    )
    df = normalize_kline_records(flatten_records(data), code, realtime=True)
    return df.iloc[-1]


def merge_realtime_row(history: pd.DataFrame, realtime_row: pd.Series) -> pd.DataFrame:
    """实时行情只用于覆盖/追加当天，判断今天是否满足买入条件。"""
    realtime = pd.DataFrame(
        [
            {
                "日期": realtime_row["日期"],
                "收盘": realtime_row["收盘"],
                "最高": realtime_row["最高"],
                "成交量": realtime_row["成交量"],
            }
        ]
    )
    history = history[history["日期"] != realtime.iloc[0]["日期"]]
    return pd.concat([history, realtime], ignore_index=True).sort_values("日期").reset_index(drop=True)


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
) -> StockResult | None:
    try:
        history = fetch_daily_history(client, code, config, retries)
        realtime_row = fetch_realtime_row(client, code, retries)
        data = add_volume_signal(merge_realtime_row(history, realtime_row), config)
        time.sleep(sleep_seconds)

        min_rows = config.long_volume_window + config.forward_days + config.recent_signal_count
        if len(data) < min_rows:
            return None

        # 条件 1：用包含当天实时行情的最新一行判断今天是否可以买入。
        latest = data.iloc[-1]
        if not bool(latest["volume_signal"]):
            return None

        # 条件 2：只用有完整后续 2 个交易日的历史信号统计胜率，不把今天信号纳入回看。
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
) -> Iterable[StockResult]:
    total = len(stocks)
    completed = 0
    hits = 0
    interval = max(1, progress_interval)
    started_at = time.time()

    log(f"[筛选] 开始并发筛选，共 {total} 只股票，线程数: {max(1, workers)}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [
            executor.submit(evaluate_stock, client, row.code, row.name, config, retries, sleep_seconds)
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


def save_results(results: list[StockResult], output: str) -> None:
    path = Path(output)
    log(f"[输出] 正在保存结果到 {path}...")
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(dataclasses.asdict(item) for item in results)
    if not df.empty:
        df = df.sort_values(["success_count", "avg_volume_12"], ascending=[False, False])
    df.to_csv(path, index=False, encoding="utf-8-sig")
    log(f"[完成] 筛选完成，共 {len(df)} 只股票满足条件，结果已保存: {path}")


def main() -> None:
    args = parse_args()
    config = StrategyConfig(history_days=args.history_days, cq=args.cq, period=args.period)
    client = load_market_client(args.fxyz_token)
    stocks = fetch_stock_list(client, args.retries)
    log(f"[配置] 行情数据源: fxyz，股票池: 东方财富，待筛选股票数: {len(stocks)}")
    results = list(iter_results(client, stocks, config, args.workers, args.retries, args.sleep, args.progress_interval))
    save_results(results, args.output)


if __name__ == "__main__":
    main()
