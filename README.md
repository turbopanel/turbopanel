# Running TurboPanel Locally

The TurboPanel platform can be run locally on your computer for testing, development, or other exotic purposes. This guide will walk you through the steps to get the platform up and running on your local machine.

## Prerequisites

Before you can run the TurboPanel platform locally, you will need to have the following installed on your machine:

- [Vagrant](https://www.vagrantup.com/)
- A supported virtualization provider:
  - [libvirt](https://libvirt.org/) (Linux
  - [Parallels](https://www.parallels.com/) (macOS)
  - [VirtualBox](https://www.virtualbox.org/) (Windows, macOS, Linux)
- Any other dependencies required by your virtualization provider to run Vagrant boxes.

## Getting Started

1. Clone the TurboPanel repository to your local machine:

    ```bash
    git clone https://github.com/turbopanel/turbopanel.git
    ```

2. Change into the `turbopanel` directory:

    ```bash
    cd turbopanel
    ```

3. Start the Vagrant environment:

    ```bash
    vagrant up
    ```

    This command will download the Vagrant box and start the virtual machine. The first time you run this command, it may take a while to download the box image. The Vagrant box is a pre-configured virtual machine that contains all the necessary software to run the TurboPanel platform.
