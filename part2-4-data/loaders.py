"""Open the two log formats and hand back plain DataFrames.

This file is given to you. Reading mcap and ulog is not part of the lab, so the
parsing is done here and every task starts from a DataFrame.

    topics = load_mcap("flight.mcap")     # {"/imu/data": DataFrame, ...}
    msgs = load_ulog("flight.ulg")        # {"sensor_combined": DataFrame, ...}

Both loaders keep the raw clock as it was recorded:

    mcap -> column ``t_ns``, nanoseconds since the epoch (1970-01-01)
    ulog -> column ``timestamp``, microseconds since the flight controller booted

Nested ROS2 fields are flattened with underscores, so
``linear_acceleration.x`` becomes the column ``linear_acceleration_x``.
Covariance arrays are dropped; they are all zero in this dataset.
"""

import pandas as pd
from mcap_ros2.reader import read_ros2_messages
from pyulog import ULog

SKIP = ("covariance", "frame_id", "header_stamp")


def _flatten(msg, prefix=""):
    """Turn one decoded ROS2 message into a flat {column: value} dict."""
    out = {}
    for name in getattr(msg, "__slots__", []) or vars(msg):
        value = getattr(msg, name)
        key = f"{prefix}{name}"
        if hasattr(value, "__slots__") or hasattr(value, "__dict__"):
            out.update(_flatten(value, key + "_"))
        elif isinstance(value, (list, tuple)):
            continue
        else:
            out[key] = value
    return out


def load_mcap(path):
    """Read an mcap file and return {topic: DataFrame}. Adds a t_ns column."""
    rows = {}
    for message in read_ros2_messages(path):
        record = _flatten(message.ros_msg)
        record = {k: v for k, v in record.items() if not any(s in k for s in SKIP)}
        record["t_ns"] = message.log_time_ns
        rows.setdefault(message.channel.topic, []).append(record)
    frames = {}
    for topic, records in rows.items():
        df = pd.DataFrame(records)
        frames[topic] = df[["t_ns"] + [c for c in df.columns if c != "t_ns"]]
    return frames


def load_ulog(path):
    """Read a ulog file and return {message name: DataFrame}."""
    log = ULog(path)
    return {d.name: pd.DataFrame({k: v for k, v in d.data.items()}) for d in log.data_list}


def describe(frames):
    """Print one line per table: name, rows, columns. Handy first look."""
    for name, df in sorted(frames.items()):
        print(f"{name:26s} {len(df):6d} rows   {list(df.columns)}")


if __name__ == "__main__":
    describe(load_mcap("flight.mcap"))
    describe(load_ulog("flight.ulg"))
