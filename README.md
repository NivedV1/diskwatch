# Diskwatch

Diskwatch reads SMART health and temperature from a Linux host's HDDs and SATA, SAS, or NVMe SSDs. It samples about every five minutes and keeps a rolling 30 days in SQLite. The dashboard shows each drive's latest health and available device metrics, a temperature chart, and a SMART history strip with 24-hour, 7-day, and 30-day views.

## Install on Linux

Requires systemd, Python 3.10 or newer with SQLite support, and the `smartmontools` package. On Fedora the package command is `sudo dnf install smartmontools`. On Debian or Ubuntu use `sudo apt install smartmontools`.

From this directory, run:

```sh
sudo ./install.sh
```

Open [Diskwatch on localhost](http://127.0.0.1:8765/). Installation attempts an initial collection and enables the collector timer and web service at boot. History builds as the collector runs. Run the same installer to update the app.

The collector runs with the device access needed for SMART. The unprivileged web service reads `/var/lib/diskwatch/history.sqlite3` and listens on IPv4 loopback. To view a different Linux host's dashboard over SSH, run `ssh -N -L 8765:127.0.0.1:8765 user@linux-host` and use the same local URL.

## Readings and hardware support

- **Healthy** means the drive's SMART status passed and Diskwatch saw no warning conditions. **Attention** indicates conditions such as pending sectors or exhausted rated NVMe endurance. **Failing** is an explicit SMART failure.
- Standby drives and failed readings appear as gaps in the chart. Available metrics depend on the drive and controller. Some USB adapters and RAID controllers need an explicit `smartctl` device type. Devices without SMART, such as typical SD cards and eMMC, are outside this collector's coverage.
- Hover the chart or focus it and use the arrow keys to inspect samples. The health strip shows the most severe reported status where multiple samples share a pixel.

To check discovery and collection:

```sh
sudo smartctl --scan-open
sudo systemctl start diskwatch-collector.service
sudo journalctl -u diskwatch-collector.service -n 30
systemctl status diskwatch-collector.timer diskwatch-web.service
```

If a controller requires an explicit device type, use `sudo systemctl edit diskwatch-collector.service` and add an override like the following. Repeat `--device` for each drive you want to monitor when using an explicit list.

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/python3 -B /usr/local/lib/diskwatch/diskwatch.py collect --device /dev/sdb=sat
```

## Preview without disk access

The demo uses an independent database and labels its readings as examples.

```sh
demo_dir=$(mktemp -d)
python3 diskwatch.py --database "$demo_dir/history.sqlite3" demo
python3 diskwatch.py --database "$demo_dir/history.sqlite3" serve --port 8766
```

Open [the demo on localhost](http://127.0.0.1:8766/).
