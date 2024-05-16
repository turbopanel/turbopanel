# -*- mode: ruby -*-
# vi: set ft=ruby :

# configurable virtual machine settings
settings = {
  cpus: 2,
  memory: 2048,
  box: "bento/ubuntu-24.04",
  box_version: "202404.26.0",
  hostname: "turbopanel"
}

# do not edit below this line
Vagrant.configure("2") do |config|

  config.vm.box = settings[:box]
  config.vm.box_version = settings[:box_version]
  config.vm.hostname = settings[:hostname]

  config.vm.provider :libvirt do |libvirt|
    libvirt.cpus = settings[:cpus]
    libvirt.memory = settings[:memory]
  end

  config.vm.provider "parallels" do |prl|
    prl.cpus = settings[:cpus]
    prl.memory = settings[:memory]
  end

  config.vm.provision "shell", path: "https://get.trbp.nl"

end
