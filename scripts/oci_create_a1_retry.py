#!/usr/bin/env python3
import argparse
import base64
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import oci
    from oci.exceptions import ServiceError
except ImportError:
    print("OCI Python SDK is not installed. Run: pip install oci", file=sys.stderr)
    sys.exit(2)


ALLOWED_SHAPE = "VM.Standard.A1.Flex"
MAX_OCPUS = 2.0
MAX_MEMORY_GB = 12.0
REQUIRED_BOOT_VOLUME_GB = 50
DEFAULT_COMPARTMENT_NAME = "always-free-a1"
DEFAULT_CONFIG_FILE = "~/.oci/config"
DEFAULT_PROFILE = "DEFAULT"
DEFAULT_REGION = "home"
DEFAULT_RETRY_WAIT_SECONDS = 60
RESULT_FILE = "INSTANCE_CREATED.json"

REQUIRED_FIELDS = [
    "availability_domain",
    "subnet_id",
    "image_id",
    "display_name",
    "shape",
    "ocpus",
    "memory_gb",
    "boot_volume_gb",
    "ssh_public_key_path",
]

CAPACITY_ERROR_MARKERS = [
    "out of capacity",
    "out of host capacity",
    "not enough capacity",
    "capacity is not available",
    "insufficient capacity",
    "too many requests",
    "toomanyrequests",
]

ALLOWED_OS_MARKERS = ("ubuntu", "oracle linux")
ARM_IMAGE_MARKERS = ("aarch64", "arm64", " arm ")


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log(message):
    print(f"[{utc_now()}] {message}", flush=True)


def load_json_config(path):
    config_path = Path(path).expanduser()
    if not config_path.exists():
        raise ValueError(f"Config file was not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        raise ValueError("Config file root must be a JSON object.")

    data["__config_dir"] = str(config_path.resolve().parent)
    return data


def resolve_local_path(settings, value):
    path = Path(value).expanduser()
    if path.is_absolute():
        return path

    config_dir = settings.get("__config_dir")
    if config_dir:
        for base in (Path(config_dir), Path(config_dir).parent):
            candidate = base / path
            if candidate.exists():
                return candidate

    return path


def apply_defaults(settings):
    settings.setdefault("region", DEFAULT_REGION)
    settings.setdefault("compartment_name", DEFAULT_COMPARTMENT_NAME)
    settings.setdefault("shape", ALLOWED_SHAPE)
    settings.setdefault("ocpus", MAX_OCPUS)
    settings.setdefault("memory_gb", MAX_MEMORY_GB)
    settings.setdefault("boot_volume_gb", REQUIRED_BOOT_VOLUME_GB)
    settings.setdefault("retry_wait_seconds", DEFAULT_RETRY_WAIT_SECONDS)
    settings.setdefault("assign_public_ip", True)
    settings.setdefault("require_home_region", True)
    settings.setdefault("allow_unverified_arm_image", False)
    return settings


def validate_settings(settings):
    missing = [field for field in REQUIRED_FIELDS if settings.get(field) in (None, "")]
    if missing:
        raise ValueError("Missing config fields: " + ", ".join(missing))

    if not settings.get("compartment_id") and not settings.get("compartment_name"):
        raise ValueError("Set compartment_name or compartment_id.")

    if settings["shape"] != ALLOWED_SHAPE:
        raise ValueError(f"Shape is restricted to {ALLOWED_SHAPE}.")

    ocpus = settings["ocpus"]
    memory_gb = settings["memory_gb"]
    boot_volume_gb = settings["boot_volume_gb"]
    retry_wait_seconds = settings.get("retry_wait_seconds", DEFAULT_RETRY_WAIT_SECONDS)

    if not isinstance(ocpus, (int, float)) or ocpus <= 0 or float(ocpus) > MAX_OCPUS:
        raise ValueError(f"ocpus must be greater than 0 and no more than {MAX_OCPUS:g}.")
    if not isinstance(memory_gb, (int, float)) or memory_gb <= 0 or float(memory_gb) > MAX_MEMORY_GB:
        raise ValueError(f"memory_gb must be greater than 0 and no more than {MAX_MEMORY_GB:g}.")
    if not isinstance(boot_volume_gb, int) or boot_volume_gb != REQUIRED_BOOT_VOLUME_GB:
        raise ValueError(f"boot_volume_gb must be {REQUIRED_BOOT_VOLUME_GB}.")
    if not isinstance(retry_wait_seconds, int) or retry_wait_seconds < 60:
        raise ValueError("retry_wait_seconds must be an integer of 60 or greater.")
    if not isinstance(settings.get("assign_public_ip"), bool):
        raise ValueError("assign_public_ip must be true or false.")


def read_ssh_public_key(settings):
    public_key_path = resolve_local_path(settings, settings["ssh_public_key_path"])
    if not public_key_path.exists():
        raise ValueError(f"SSH public key was not found: {public_key_path}")
    if public_key_path.suffix.lower() != ".pub":
        raise ValueError("ssh_public_key_path must point to a .pub file.")

    public_key = public_key_path.read_text(encoding="utf-8").strip()
    if not public_key:
        raise ValueError("SSH public key file is empty.")
    if "PRIVATE KEY" in public_key:
        raise ValueError("Use the SSH public key .pub file, not a private key.")
    return public_key


def read_cloud_init_user_data(settings):
    script_path = settings.get("cloud_init_script_path")
    if not script_path:
        return None

    path = resolve_local_path(settings, script_path)
    if not path.exists():
        raise ValueError(f"cloud_init_script_path was not found: {path}")

    content = path.read_bytes()
    if not content:
        raise ValueError("cloud_init_script_path is empty.")

    return base64.b64encode(content).decode("ascii")


def load_oci_config(settings):
    config_file = Path(settings.get("oci_config_file", DEFAULT_CONFIG_FILE)).expanduser()
    profile = settings.get("profile", DEFAULT_PROFILE)
    return oci.config.from_file(file_location=str(config_file), profile_name=profile)


def get_region_name(subscription):
    return getattr(subscription, "region_name", None) or getattr(subscription, "region_key", None)


def get_home_region(identity_client, tenancy_id):
    response = identity_client.list_region_subscriptions(tenancy_id)
    for subscription in response.data:
        if getattr(subscription, "is_home_region", False):
            region_name = get_region_name(subscription)
            if region_name:
                return region_name
    raise ValueError("Could not resolve OCI home region from region subscriptions.")


def resolve_region(identity_client, oci_config, settings):
    requested_region = str(settings.get("region") or oci_config.get("region") or "").strip()
    if not requested_region:
        raise ValueError("Set region in the JSON config or ~/.oci/config.")

    tenancy_id = oci_config["tenancy"]
    home_region = get_home_region(identity_client, tenancy_id)

    if requested_region.lower() == "home":
        log(f"Using OCI home region: {home_region}")
        return home_region

    if settings.get("require_home_region", True) and requested_region != home_region:
        raise ValueError(
            f"Configured region is {requested_region}, but the home region is {home_region}. "
            "Set region to home or set require_home_region to false."
        )

    return requested_region


def resolve_compartment_id(identity_client, tenancy_id, settings):
    configured_id = str(settings.get("compartment_id") or "").strip()
    if configured_id:
        return configured_id

    compartment_name = str(settings.get("compartment_name") or DEFAULT_COMPARTMENT_NAME).strip()
    if not compartment_name:
        raise ValueError("compartment_name is empty.")

    response = oci.pagination.list_call_get_all_results(
        identity_client.list_compartments,
        compartment_id=tenancy_id,
        compartment_id_in_subtree=True,
        access_level="ANY",
    )
    matches = [
        compartment
        for compartment in response.data
        if compartment.name == compartment_name and compartment.lifecycle_state == "ACTIVE"
    ]

    if not matches:
        raise ValueError(f"Active compartment named {compartment_name!r} was not found.")
    if len(matches) > 1:
        ocids = ", ".join(compartment.id for compartment in matches)
        raise ValueError(f"Multiple active compartments named {compartment_name!r} were found: {ocids}")

    compartment = matches[0]
    log(f"Using compartment: {compartment.name} ({compartment.id})")
    return compartment.id


def is_capacity_error(error):
    text = f"{getattr(error, 'code', '')} {getattr(error, 'message', '')}".lower()
    return any(marker in text for marker in CAPACITY_ERROR_MARKERS)


def service_error_summary(error):
    code = getattr(error, "code", "Unknown")
    status = getattr(error, "status", "Unknown")
    message = getattr(error, "message", str(error))
    opc_request_id = getattr(error, "opc_request_id", None)
    parts = [f"status={status}", f"code={code}", f"message={message}"]
    if opc_request_id:
        parts.append(f"opc-request-id={opc_request_id}")
    return ", ".join(parts)


def list_active_instances(compute_client, compartment_id, display_name):
    instances = []
    response = oci.pagination.list_call_get_all_results(
        compute_client.list_instances,
        compartment_id=compartment_id,
        display_name=display_name,
    )
    for instance in response.data:
        if instance.lifecycle_state not in ("TERMINATED", "TERMINATING"):
            instances.append(instance)
    return instances


def shape_config_value(instance, field):
    shape_config = getattr(instance, "shape_config", None)
    if shape_config is None:
        return None
    return getattr(shape_config, field, None)


def ensure_instance_matches_settings(instance, settings):
    errors = []
    if instance.shape != settings["shape"]:
        errors.append(f"shape={instance.shape}")

    existing_ocpus = shape_config_value(instance, "ocpus")
    existing_memory = shape_config_value(instance, "memory_in_gbs")

    if existing_ocpus is not None and abs(float(existing_ocpus) - float(settings["ocpus"])) > 0.001:
        errors.append(f"ocpus={existing_ocpus}")
    if existing_memory is not None and abs(float(existing_memory) - float(settings["memory_gb"])) > 0.001:
        errors.append(f"memory_gb={existing_memory}")

    if errors:
        details = ", ".join(errors)
        raise ValueError(
            f"An active instance with display_name={settings['display_name']!r} already exists, "
            f"but it does not match this config: {details}."
        )


def get_primary_public_ip(compute_client, network_client, compartment_id, instance_id):
    attachments = oci.pagination.list_call_get_all_results(
        compute_client.list_vnic_attachments,
        compartment_id=compartment_id,
        instance_id=instance_id,
    ).data

    for attachment in attachments:
        if attachment.lifecycle_state == "ATTACHED" and attachment.vnic_id:
            vnic = network_client.get_vnic(attachment.vnic_id).data
            if getattr(vnic, "is_primary", False):
                return vnic.public_ip

    for attachment in attachments:
        if attachment.lifecycle_state == "ATTACHED" and attachment.vnic_id:
            vnic = network_client.get_vnic(attachment.vnic_id).data
            return vnic.public_ip

    return None


def wait_for_public_ip(compute_client, network_client, compartment_id, instance_id, timeout_seconds=600):
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        public_ip = get_primary_public_ip(compute_client, network_client, compartment_id, instance_id)
        if public_ip:
            return public_ip
        time.sleep(10)
    return None


def infer_ssh_user(settings):
    configured_user = settings.get("ssh_user")
    if configured_user:
        return configured_user

    image_name = " ".join(
        str(settings.get(key, ""))
        for key in ("image_name", "os", "operating_system")
    ).lower()
    if "oracle" in image_name:
        return "opc"
    return "ubuntu"


def private_key_path_from_public_key(public_key_path):
    path_text = str(public_key_path)
    if path_text.lower().endswith(".pub"):
        return path_text[:-4]
    return path_text


def ssh_command(private_key_path, ssh_user, public_ip):
    return f"ssh -i {private_key_path} {ssh_user}@{public_ip}"


def validate_image(compute_client, settings):
    image = compute_client.get_image(settings["image_id"]).data
    image_text = " ".join(
        str(getattr(image, field, "") or "")
        for field in ("display_name", "operating_system", "operating_system_version")
    )
    image_text_lower = f" {image_text.lower()} "

    if not any(marker in image_text_lower for marker in ALLOWED_OS_MARKERS):
        raise ValueError(
            "Image OS must be Ubuntu or Oracle Linux. "
            f"OCI returned: {image_text}"
        )

    if not any(marker in image_text_lower for marker in ARM_IMAGE_MARKERS):
        if not settings.get("allow_unverified_arm_image", False):
            raise ValueError(
                "Image name does not look like an Arm image. "
                "Use an AArch64/Arm64 Ubuntu or Oracle Linux image, "
                "or set allow_unverified_arm_image to true after manual review. "
                f"OCI returned: {image_text}"
            )
        log(f"Arm image marker was not detected. Manual override is enabled: {image_text}")

    settings["image_name"] = image_text
    log(f"Using image: {image_text}")


def validate_subnet(network_client, settings):
    subnet = network_client.get_subnet(settings["subnet_id"]).data
    if getattr(subnet, "lifecycle_state", None) not in (None, "AVAILABLE"):
        raise ValueError(f"Subnet is not AVAILABLE: {getattr(subnet, 'lifecycle_state', None)}")

    if settings.get("assign_public_ip", True) and getattr(subnet, "prohibit_public_ip_on_vnic", False):
        raise ValueError(
            "assign_public_ip is true, but the selected subnet prohibits public IP addresses."
        )

    log(f"Using subnet: {getattr(subnet, 'display_name', settings['subnet_id'])} ({settings['subnet_id']})")


def launch_instance(compute_client, settings, ssh_public_key):
    metadata = {
        "ssh_authorized_keys": ssh_public_key,
    }
    user_data = read_cloud_init_user_data(settings)
    if user_data:
        metadata["user_data"] = user_data

    launch_details = oci.core.models.LaunchInstanceDetails(
        availability_domain=settings["availability_domain"],
        compartment_id=settings["compartment_id"],
        display_name=settings["display_name"],
        shape=settings["shape"],
        shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(
            ocpus=float(settings["ocpus"]),
            memory_in_gbs=float(settings["memory_gb"]),
        ),
        source_details=oci.core.models.InstanceSourceViaImageDetails(
            image_id=settings["image_id"],
            boot_volume_size_in_gbs=int(settings["boot_volume_gb"]),
        ),
        create_vnic_details=oci.core.models.CreateVnicDetails(
            subnet_id=settings["subnet_id"],
            assign_public_ip=settings.get("assign_public_ip", True),
        ),
        metadata=metadata,
        freeform_tags={
            "app": "wari",
            "component": "receipt-ocr",
            "managed-by": "oci_create_a1_retry.py",
        },
    )
    return compute_client.launch_instance(launch_details).data


def wait_for_instance_running(compute_client, instance_id):
    response = oci.wait_until(
        compute_client,
        compute_client.get_instance(instance_id),
        "lifecycle_state",
        "RUNNING",
        max_wait_seconds=1800,
        max_interval_seconds=30,
    )
    return response.data


def save_result(result):
    result_path = Path(RESULT_FILE)
    with result_path.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return result_path.resolve()


def print_result(result):
    print("")
    print("Creation result")
    print(f"Instance OCID: {result['instance_id']}")
    print(f"Region: {result['region']}")
    print(f"Compartment OCID: {result['compartment_id']}")
    print(f"Shape: {result['shape']}")
    print(f"OCPU: {result['ocpus']}")
    print(f"Memory GB: {result['memory_gb']}")
    print(f"Boot volume GB: {result['boot_volume_gb']}")
    print(f"Public IP: {result.get('public_ip') or '(not assigned)'}")
    print(f"SSH user: {result['ssh_user']}")
    if result.get("ssh_command"):
        print(f"SSH command: {result['ssh_command']}")
    print(f"Saved: {result['result_file']}")


def build_result(settings, instance, public_ip, result_path=None):
    public_key_path = settings["ssh_public_key_path"]
    private_key_path = settings.get("ssh_private_key_path") or private_key_path_from_public_key(public_key_path)
    ssh_user = infer_ssh_user(settings)
    command = ssh_command(private_key_path, ssh_user, public_ip) if public_ip else None
    return {
        "created_at": utc_now(),
        "instance_id": instance.id,
        "display_name": instance.display_name,
        "lifecycle_state": instance.lifecycle_state,
        "availability_domain": instance.availability_domain,
        "region": settings["region"],
        "compartment_id": settings["compartment_id"],
        "shape": instance.shape,
        "ocpus": settings["ocpus"],
        "memory_gb": settings["memory_gb"],
        "boot_volume_gb": settings["boot_volume_gb"],
        "image_id": settings["image_id"],
        "image_name": settings.get("image_name"),
        "public_ip": public_ip,
        "ssh_user": ssh_user,
        "ssh_command": command,
        "result_file": str(result_path) if result_path else str(Path(RESULT_FILE).resolve()),
    }


def parse_args():
    parser = argparse.ArgumentParser(
        description="Retry OCI A1 Flex instance creation with Wari OCR safety checks."
    )
    parser.add_argument("--config", required=True, help="Path to JSON config file.")
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        settings = apply_defaults(load_json_config(args.config))
        validate_settings(settings)
        ssh_public_key = read_ssh_public_key(settings)
        oci_config = load_oci_config(settings)
        identity_client = oci.identity.IdentityClient(oci_config)
        settings["region"] = resolve_region(identity_client, oci_config, settings)
        oci_config["region"] = settings["region"]
        identity_client = oci.identity.IdentityClient(oci_config)
        settings["compartment_id"] = resolve_compartment_id(identity_client, oci_config["tenancy"], settings)
    except (
        ValueError,
        json.JSONDecodeError,
        oci.exceptions.ConfigFileNotFound,
        oci.exceptions.InvalidConfig,
        oci.exceptions.ProfileNotFound,
        ServiceError,
    ) as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2

    compute_client = oci.core.ComputeClient(oci_config)
    network_client = oci.core.VirtualNetworkClient(oci_config)

    display_name = settings["display_name"]
    compartment_id = settings["compartment_id"]
    retry_wait_seconds = settings.get("retry_wait_seconds", DEFAULT_RETRY_WAIT_SECONDS)

    try:
        validate_image(compute_client, settings)
        validate_subnet(network_client, settings)
        existing_instances = list_active_instances(compute_client, compartment_id, display_name)
    except ServiceError as error:
        print(f"Preflight OCI check failed: {service_error_summary(error)}", file=sys.stderr)
        return 2
    except ValueError as error:
        print(f"Preflight check failed: {error}", file=sys.stderr)
        return 2

    if existing_instances:
        instance = existing_instances[0]
        try:
            ensure_instance_matches_settings(instance, settings)
            public_ip = get_primary_public_ip(compute_client, network_client, compartment_id, instance.id)
        except ServiceError as error:
            print(f"Failed to inspect existing instance: {service_error_summary(error)}", file=sys.stderr)
            return 2
        except ValueError as error:
            print(f"Existing instance mismatch: {error}", file=sys.stderr)
            return 2
        result = build_result(settings, instance, public_ip)
        log(f"Active instance with the same display name exists: {instance.id} ({instance.lifecycle_state})")
        print_result(result)
        return 0

    attempt = 0
    while True:
        attempt += 1
        log(
            f"Create attempt {attempt}: {display_name} / {ALLOWED_SHAPE} / "
            f"OCPU={settings['ocpus']} / Memory={settings['memory_gb']}GB / "
            f"Boot={settings['boot_volume_gb']}GB / Region={settings['region']}"
        )

        try:
            instance = launch_instance(compute_client, settings, ssh_public_key)
            log(f"Launch request accepted: {instance.id}")
            running_instance = wait_for_instance_running(compute_client, instance.id)
            public_ip = wait_for_public_ip(compute_client, network_client, compartment_id, running_instance.id)
            result = build_result(settings, running_instance, public_ip)
            result_path = save_result(result)
            result["result_file"] = str(result_path)
            save_result(result)
            print_result(result)
            return 0
        except KeyboardInterrupt:
            print("")
            log("Interrupted by Ctrl+C. Created resources are not deleted by this command.")
            return 130
        except ServiceError as error:
            if is_capacity_error(error):
                log(f"Capacity retry condition: {service_error_summary(error)}")
                log(f"Retrying after {retry_wait_seconds} seconds.")
                try:
                    time.sleep(retry_wait_seconds)
                except KeyboardInterrupt:
                    print("")
                    log("Interrupted by Ctrl+C. Created resources are not deleted by this command.")
                    return 130
                continue

            print(f"Stopped on non-capacity OCI error: {service_error_summary(error)}", file=sys.stderr)
            return 2
        except Exception as error:
            print(f"Stopped on unexpected error: {error}", file=sys.stderr)
            return 2


if __name__ == "__main__":
    sys.exit(main())
