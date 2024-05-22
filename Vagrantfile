# -*- mode: ruby -*-
# vi: set ft=ruby :

# configure local virtual machine settings
settings = {
  cpus: 4,
  memory: 4096,
  box: "bento/ubuntu-24.04",
  box_version: "202404.26.0",
  name: "turbopanel"
}

# edits below this line may cause unexpected behavior
Vagrant.configure("2") do |config|

  # config.vm.network "public_network"

  config.vm.box = settings[:box]

  # use the specified box version only if not falsy; otherwise the most recent version will be used
  config.vm.box_version = settings[:box_version] unless settings[:box_version].nil? || settings[:box_version].strip.empty?

  config.vm.hostname = settings[:name]

  config.vm.provision "shell", inline: <<-SHELL
    sudo mkdir -p /opt/turbopanel
    sudo chown vagrant:vagrant /opt/turbopanel
    echo "cd /opt/turbopanel" >> /home/vagrant/.bashrc
  SHELL

  # config.vm.synced_folder ".", "/vagrant", disabled: true
  config.vm.synced_folder ".", "/opt/turbopanel"

  config.vm.network "forwarded_port", guest: 80, host: 80
  config.vm.network "forwarded_port", guest: 8088, host: 8088
  config.vm.network "forwarded_port", guest: 443, host: 443
  config.vm.network "forwarded_port", guest: 3306, host: 3306
  config.vm.network "forwarded_port", guest: 2082, host: 2082
  config.vm.network "forwarded_port", guest: 2083, host: 2083
  config.vm.network "forwarded_port", guest: 2086, host: 2086
  config.vm.network "forwarded_port", guest: 2087, host: 2087
  config.vm.network "forwarded_port", guest: 2089, host: 2089
  config.vm.network "forwarded_port", guest: 7080, host: 7080

  config.vm.provider :libvirt do |libvirt|
    libvirt.cpus = settings[:cpus]
    libvirt.memory = settings[:memory]
  end

  config.vm.provider "parallels" do |parallels|
    parallels.cpus = settings[:cpus]
    parallels.memory = settings[:memory]
    parallels.name = settings[:name]
    parallels.update_guest_tools = true
  end

  config.vm.provider "virtualbox" do |virtualbox|
    virtualbox.memory = settings[:memory]
    virtualbox.cpus = settings[:cpus]
  end

  # use web installer
  # config.vm.provision "shell", path: "https://get.trbp.nl"

  # use vagrant docker provisioner
  # config.vm.provision "docker" do |d|
    # Build the image
  #  d.build_image "/opt/turbopanel",
  #    args: [
  #      "-f /opt/turbopanel/image/Dockerfile",
  #      "-t ghcr.io/turbopanel/turbopanel:latest"
  #    ].join(" ")
  # end

  config.vm.provision "docker",
    images: ["ghcr.io/turbopanel/turbopanel:1.0-development"]

end
