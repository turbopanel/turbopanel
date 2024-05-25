<?php

namespace Core\Database\Migrations;

use CodeIgniter\Database\Migration;

class Sites extends Migration {
    public function up() {
        $this->forge->addField([
            'ID' => [
                'type'           => 'INT',
                'constraint'     => 5,
                'unsigned'       => true,
                'auto_increment' => true,
            ],
            'PrimaryDomainName' => [
                'type'       => 'VARCHAR',
                'constraint' => '100',
            ],
            'CreatedAtUTC' => [
                'type' => 'DATETIME',
            ],
            'CreatedByUserID' => [
                'type'       => 'INT',
                'constraint' => 5,
            ],
            'UpdatedAtUTC' => [
                'type' => 'DATETIME',
            ],
            'UpdatedByUserID' => [
                'type'       => 'INT',
                'constraint' => 5,
            ],
            'DeletedAtUTC' => [
                'type' => 'DATETIME',
                'null' => true,
            ],
            'DeletedByUserID' => [
                'type'       => 'INT',
                'constraint' => 5,
                'null' => true,
            ],
            'Status' => [
                'type'       => 'INT',
                'constraint' => 5,
            ],
        ]);
        $this->forge->addPrimaryKey('ID');
        $this->forge->createTable('Hosting');
    }

    public function down()
    {
        $this->forge->dropTable('Account');
    }
}
